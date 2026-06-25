import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import { getBookClubCollections, PollDocument, PollType } from "../book-club.js";
import { buildPollComponents, buildPollEmbed } from "../polls.js";

export const data = new SlashCommandBuilder()
  .setName("start-book-poll")
  .setDescription("Start a poll using the current book nominations.")
  .addStringOption((option) =>
    option
      .setName("type")
      .setDescription("Choose how votes are counted.")
      .addChoices({ name: "Regular", value: "regular" }, { name: "Ranked", value: "ranked" }),
  )
  .addNumberOption((option) =>
    option
      .setName("hours")
      .setDescription("How many hours the poll should stay open.")
      .setRequired(true)
      .setMinValue(1),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const pollType = (interaction.options.getString("type") ?? "regular") as PollType;
  const hours = interaction.options.getNumber("hours", true);
  const { nominations, polls } = getBookClubCollections();

  const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" });
  if (activePoll) {
    await interaction.reply({
      content: `There is already an active poll. Close poll \`${activePoll.pollId}\` before starting another one.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nominationDocs = await nominations
    .find({ guildId: interaction.guildId, status: "nominated" })
    .sort({ createdAt: 1 })
    .toArray();

  const now = new Date();
  const closesAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
  const poll: PollDocument = {
    pollId: randomUUID(),
    documentType: "poll",
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    status: "active",
    pollType,
    options: nominationDocs.map((nomination) => ({
      nominationId: nomination.nominationId,
      title: nomination.title,
      normalizedTitle: nomination.normalizedTitle,
      author: nomination.author,
      nominatedBy: nomination.nominatedBy,
      reason: nomination.reason,
      imageUrl: nomination.imageUrl,
    })),
    votes: {},
    createdBy: interaction.user.id,
    createdByUsername: interaction.user.username,
    winner: null,
    createdAt: now,
    updatedAt: now,
    closesAt,
    closedAt: null,
  };

  await polls.insertOne(poll);
  await interaction.reply({
    embeds: [buildPollEmbed(poll)],
    components: buildPollComponents(poll),
  });

  const message = await interaction.fetchReply();
  await polls.updateOne({ pollId: poll.pollId }, { $set: { messageId: message.id } });
}
