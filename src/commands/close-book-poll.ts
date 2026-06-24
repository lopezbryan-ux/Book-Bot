import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildBookAddedEmbed } from "../book-embeds.js";
import { getBookClubCollections, formatBookTitle } from "../book-club.js";
import { buildPollComponents, buildPollEmbed, getWinningOptions } from "../polls.js";

export const data = new SlashCommandBuilder()
  .setName("close-book-poll")
  .setDescription("Close the active book poll and add the winner to the book list.")
  .addStringOption((option) => option.setName("poll-id").setDescription("Optional poll ID to close."));

export async function execute(interaction: ChatInputCommandInteraction) {
  const pollId = interaction.options.getString("poll-id")?.trim();
  const { books, nominations, polls } = getBookClubCollections();

  const poll = pollId
    ? await polls.findOne({ pollId, guildId: interaction.guildId, status: "active" })
    : await polls.findOne({ guildId: interaction.guildId, status: "active" }, { sort: { createdAt: -1 } });

  if (!poll) {
    await interaction.reply({ content: "There is no active poll to close.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { highestVoteCount, winners } = getWinningOptions(poll);
  const now = new Date();

  if (winners.length === 0) {
    await polls.updateOne({ pollId: poll.pollId }, { $set: { status: "closed", closedAt: now, updatedAt: now } });
    await interaction.reply("Closed the poll. No book was added because nobody voted.");
    return;
  }

  if (winners.length > 1) {
    const tiedBooks = winners.map((winner) => `**${formatBookTitle(winner.title, winner.author)}**`).join(", ");
    await polls.updateOne({ pollId: poll.pollId }, { $set: { status: "closed", closedAt: now, updatedAt: now } });
    await interaction.reply(`Closed the poll. No book was added because there was a tie between ${tiedBooks}.`);
    return;
  }

  const winner = winners[0];

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

  const closedPoll = {
    ...poll,
    status: "closed" as const,
    winner,
    closedAt: now,
    updatedAt: now,
  };

  await polls.updateOne(
    { pollId: poll.pollId },
    {
      $set: {
        status: "closed",
        winner,
        closedAt: now,
        updatedAt: now,
      },
    },
  );

  if (poll.messageId && interaction.channel?.isTextBased()) {
    const pollMessage = await interaction.channel.messages.fetch(poll.messageId).catch(() => null);
    await pollMessage?.edit({
      embeds: [buildPollEmbed(closedPoll)],
      components: buildPollComponents(closedPoll, true),
    });
  }

  await interaction.reply({
    content: `Closed the poll. The winner had ${highestVoteCount} vote${highestVoteCount === 1 ? "" : "s"}.`,
    embeds: [
      buildBookAddedEmbed({
        action: "Poll winner added to the club book list",
        title: winner.title,
        author: winner.author,
        imageUrl: winner.imageUrl,
        note: null,
        footerText: `Poll ID: ${poll.pollId}`,
      }),
    ],
  });
}
