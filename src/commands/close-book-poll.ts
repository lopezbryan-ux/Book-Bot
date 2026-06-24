import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { getBookClubCollections, formatBookTitle } from "../book-club.js";
import { buildPollComponents, buildPollEmbed, getWinningOptions } from "../polls.js";

export const data = new SlashCommandBuilder()
  .setName("close-book-poll")
  .setDescription("Close every active book poll.");

export async function execute(interaction: ChatInputCommandInteraction) {
  const { books, nominations, polls } = getBookClubCollections();
  const activePolls = await polls
    .find({ guildId: interaction.guildId, status: "active" })
    .sort({ createdAt: 1 })
    .toArray();

  if (activePolls.length === 0) {
    await interaction.reply({ content: "There are no active polls to close.", flags: MessageFlags.Ephemeral });
    return;
  }

  const now = new Date();
  const summaries: string[] = [];

  for (const poll of activePolls) {
    const { highestVoteCount, winners } = getWinningOptions(poll);
    const scoreLabel = poll.pollType === "ranked" ? "point" : "vote";
    const winner = winners.length === 1 ? winners[0] : null;

    if (winner) {
      await books.updateOne(
        {
          documentType: "book",
          guildId: interaction.guildId,
          normalizedTitle: winner.normalizedTitle,
        },
        {
          $set: {
            documentType: "book",
            guildId: interaction.guildId,
            title: winner.title,
            normalizedTitle: winner.normalizedTitle,
            author: winner.author,
            imageUrl: winner.imageUrl,
            source: "poll",
            sourcePollId: poll.pollId,
            note: null,
            addedBy: null,
            addedByUsername: null,
            selectedAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );

      await nominations.updateOne(
        { nominationId: winner.nominationId, guildId: interaction.guildId },
        { $set: { status: "selected", updatedAt: now } },
      );
    }

    const closedPoll = {
      ...poll,
      status: "closed" as const,
      winner,
      closedAt: now,
      updatedAt: now,
    };

    await polls.updateOne(
      { pollId: poll.pollId, guildId: interaction.guildId },
      {
        $set: {
          status: "closed",
          winner,
          closedAt: now,
          updatedAt: now,
        },
      },
    );

    if (poll.messageId) {
      const channel =
        poll.channelId === interaction.channelId
          ? interaction.channel
          : await interaction.client.channels.fetch(poll.channelId).catch(() => null);

      if (channel?.isTextBased() && "messages" in channel) {
        const pollMessage = await channel.messages.fetch(poll.messageId).catch(() => null);
        await pollMessage?.edit({
          embeds: [buildPollEmbed(closedPoll)],
          components: buildPollComponents(closedPoll, true),
        });
      }
    }

    if (winner) {
      summaries.push(
        `- Closed \`${poll.pollId}\`: added **${formatBookTitle(winner.title, winner.author)}** with ${highestVoteCount} ${scoreLabel}${
          highestVoteCount === 1 ? "" : "s"
        }.`,
      );
    } else if (winners.length > 1) {
      const tiedBooks = winners.map((tiedWinner) => `**${formatBookTitle(tiedWinner.title, tiedWinner.author)}**`).join(", ");
      summaries.push(`- Closed \`${poll.pollId}\`: no book added because there was a tie between ${tiedBooks}.`);
    } else {
      summaries.push(`- Closed \`${poll.pollId}\`: no book added because nobody voted.`);
    }
  }

  const clearedNominations = await nominations.deleteMany({
    documentType: "nomination",
    guildId: interaction.guildId,
  });

  await interaction.reply(
    `Closed ${activePolls.length} active poll${activePolls.length === 1 ? "" : "s"} and cleared ${
      clearedNominations.deletedCount
    } nomination${clearedNominations.deletedCount === 1 ? "" : "s"}.\n${summaries.join("\n")}`,
  );
}
