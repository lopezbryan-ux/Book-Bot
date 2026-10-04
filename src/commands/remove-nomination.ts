import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatBookTitle, getBookClubCollections } from "../book-club.js";
import { remapPollVotes } from "../poll-votes.js";
import { refreshPollMessage } from "../polls.js";
import { mongoClient } from "../mongo.js";
import { isPollOpen, openPollFilter, PollClosedError } from "../poll-state.js";

export const data = new SlashCommandBuilder()
  .setName("remove-nomination")
  .setDescription("Remove one of your nominations from the active book poll.")
  .addStringOption((option) =>
    option
      .setName("nomination")
      .setDescription("Choose one of your nominated books.")
      .setAutocomplete(true)
      .setRequired(true),
  );

function truncateChoiceName(value: string) {
  return value.length > 100 ? value.slice(0, 100) : value;
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().trim().toLowerCase();
  const { polls } = getBookClubCollections();
  const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" });

  if (!activePoll || !isPollOpen(activePoll)) {
    await interaction.respond([]);
    return;
  }

  const choices = activePoll.options
    .filter((option) => option.nominatedBy === interaction.user.id)
    .filter((option) => !focusedValue || formatBookTitle(option.title, option.author).toLowerCase().includes(focusedValue))
    .sort((left, right) => left.title.localeCompare(right.title))
    .slice(0, 25)
    .map((option) => ({
      name: truncateChoiceName(formatBookTitle(option.title, option.author)),
      value: option.nominationId,
    }));

  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const nominationId = interaction.options.getString("nomination", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { nominations, polls } = getBookClubCollections();
  const result = await mongoClient.withSession((session) => session.withTransaction(async () => {
    const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" }, { session });
    if (!activePoll || !isPollOpen(activePoll)) return { error: "There is no open book poll right now." };

    const optionIndex = activePoll.options.findIndex(
      (option) => option.nominationId === nominationId && option.nominatedBy === interaction.user.id,
    );
    const removedOption = activePoll.options[optionIndex];
    if (!removedOption) return { error: "That nomination is not yours or is no longer part of the open poll." };

    const options = activePoll.options.filter((_, index) => index !== optionIndex);
    const indexMap = new Map<number, number>();
    activePoll.options.forEach((_, index) => {
      if (index < optionIndex) indexMap.set(index, index);
      if (index > optionIndex) indexMap.set(index, index - 1);
    });
    const votes = remapPollVotes(activePoll.votes, indexMap);
    const updatedAt = new Date();
    const update = await polls.updateOne(openPollFilter(activePoll.pollId, interaction.guildId), {
      $set: { options, votes, updatedAt },
    }, { session });
    if (update.matchedCount === 0) throw new PollClosedError();

    await nominations.deleteOne({
      nominationId, guildId: interaction.guildId, nominatedBy: interaction.user.id, status: "nominated",
    }, { session });
    return { poll: { ...activePoll, options, votes, updatedAt }, removedOption };
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } })).catch((error: unknown) => {
    if (error instanceof PollClosedError) return { error: error.message };
    throw error;
  });

  if ("error" in result) {
    await interaction.editReply({ content: result.error });
    return;
  }
  await refreshPollMessage(interaction.client, result.poll);
  await interaction.editReply({
    content: `Removed **${formatBookTitle(result.removedOption.title, result.removedOption.author)}** from the active poll. Votes for it were cleared; affected ranked ballots need a new pick to count.`,
  });
}
