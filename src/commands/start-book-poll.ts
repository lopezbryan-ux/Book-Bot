import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import { getBookClubCollections, PollDocument } from "../book-club.js";
import { buildPollComponents, buildPollEmbed } from "../polls.js";

export const data = new SlashCommandBuilder()
  .setName("start-book-poll")
  .setDescription("Start a poll using the current book nominations.")
  .addIntegerOption((option) =>
    option
      .setName("limit")
      .setDescription("How many nominations to include, from 2 to 10.")
      .setMinValue(2)
      .setMaxValue(10),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const limit = interaction.options.getInteger("limit") ?? 10;
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
    .limit(limit)
    .toArray();

  if (nominationDocs.length < 2) {
    await interaction.reply({
      content: "Nominate at least two books before starting a poll.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = new Date();
  const poll: PollDocument = {
    pollId: randomUUID(),
    documentType: "poll",
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    status: "active",
    options: nominationDocs.map((nomination) => ({
      nominationId: nomination.nominationId,
      title: nomination.title,
      normalizedTitle: nomination.normalizedTitle,
      author: nomination.author,
      nominatedBy: nomination.nominatedBy,
      reason: nomination.reason,
    })),
    votes: {},
    createdBy: interaction.user.id,
    createdByUsername: interaction.user.username,
    winner: null,
    createdAt: now,
    updatedAt: now,
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
