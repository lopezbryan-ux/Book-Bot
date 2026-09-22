import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatBookTitle, getBookClubCollections, PollDocument } from "../book-club.js";
import { remapPollVotes } from "../poll-votes.js";
import { buildPollComponents, buildPollEmbed } from "../polls.js";

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

async function refreshPollMessage(interaction: ChatInputCommandInteraction, poll: PollDocument) {
  if (!poll.messageId) return;

  const channel =
    poll.channelId === interaction.channelId
      ? interaction.channel
      : await interaction.client.channels.fetch(poll.channelId).catch(() => null);

  if (!channel?.isTextBased() || !("messages" in channel)) return;

  const pollMessage = await channel.messages.fetch(poll.messageId).catch(() => null);
  await pollMessage?.edit({
    embeds: [buildPollEmbed(poll)],
    components: buildPollComponents(poll),
  });
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().trim().toLowerCase();
  const { polls } = getBookClubCollections();
  const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" });

  if (!activePoll) {
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
  const { nominations, polls } = getBookClubCollections();
  const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" });

  if (!activePoll) {
    await interaction.reply({ content: "There is no active book poll right now.", flags: MessageFlags.Ephemeral });
    return;
  }

  const optionIndex = activePoll.options.findIndex(
    (option) => option.nominationId === nominationId && option.nominatedBy === interaction.user.id,
  );
  const removedOption = activePoll.options[optionIndex];

  if (!removedOption) {
    await interaction.reply({
      content: "That nomination is not yours or is no longer part of the active poll.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const remainingOptions = activePoll.options.filter((_, index) => index !== optionIndex);
  const indexMap = new Map<number, number>();
  activePoll.options.forEach((_, index) => {
    if (index < optionIndex) indexMap.set(index, index);
    if (index > optionIndex) indexMap.set(index, index - 1);
  });

  const now = new Date();
  const updateResult = await polls.updateOne(
    {
      pollId: activePoll.pollId,
      guildId: interaction.guildId,
      status: "active",
      "options.nominationId": nominationId,
    },
    {
      $set: {
        options: remainingOptions,
        votes: remapPollVotes(activePoll.votes, indexMap),
        updatedAt: now,
      },
    },
  );

  if (updateResult.matchedCount === 0) {
    await interaction.reply({
      content: "That nomination was already removed from the active poll.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await nominations.deleteOne({
    nominationId,
    guildId: interaction.guildId,
    nominatedBy: interaction.user.id,
    status: "nominated",
  });

  const updatedPoll = await polls.findOne({ pollId: activePoll.pollId, guildId: interaction.guildId });
  if (updatedPoll) {
    await refreshPollMessage(interaction, updatedPoll);
  }

  await interaction.reply({
    content: `Removed **${formatBookTitle(removedOption.title, removedOption.author)}** from the active poll.`,
    flags: MessageFlags.Ephemeral,
  });
}
