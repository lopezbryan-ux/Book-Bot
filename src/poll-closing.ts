import { Client, EmbedBuilder } from "discord.js";
import { formatBookTitle, getBookClubCollections, PollDocument, RankedPollVote } from "./book-club.js";
import { buildPollComponents, buildPollEmbed, getWinningOptions } from "./polls.js";

interface CloseActiveBookPollsOptions {
  client: Client;
  addWinners?: boolean;
  guildId?: string | null;
  overdueOnly?: boolean;
  now?: Date;
}

export interface CloseActiveBookPollsResult {
  closedCount: number;
  clearedNominationCount: number;
  summaries: string[];
}

async function updatePollMessage(client: Client, poll: PollDocument, closedPoll: PollDocument) {
  if (!poll.messageId) return;

  const channel = await client.channels.fetch(poll.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) return;

  const pollMessage = await channel.messages.fetch(poll.messageId).catch(() => null);
  await pollMessage?.edit({
    embeds: [buildPollEmbed(closedPoll)],
    components: buildPollComponents(closedPoll, true),
  });
}

function isRankedPollVote(value: unknown): value is RankedPollVote {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildVoteRevealLines(poll: PollDocument) {
  const lines: string[] = [];

  for (const [userId, vote] of Object.entries(poll.votes ?? {})) {
    if (typeof vote === "number") {
      const option = poll.options[vote];
      if (!option) continue;

      lines.push(`- <@${userId}> voted for **${formatBookTitle(option.title, option.author)}**: 1 point`);
      continue;
    }

    if (!isRankedPollVote(vote)) continue;

    const rankedLines = [
      { label: "#1", optionIndex: vote.first, points: 3 },
      { label: "#2", optionIndex: vote.second, points: 2 },
      { label: "#3", optionIndex: vote.third, points: 1 },
    ]
      .map(({ label, optionIndex, points }) => {
        if (typeof optionIndex !== "number") return null;

        const option = poll.options[optionIndex];
        if (!option) return null;

        return `${label} **${formatBookTitle(option.title, option.author)}** (${points} point${points === 1 ? "" : "s"})`;
      })
      .filter((line): line is string => Boolean(line));

    if (rankedLines.length > 0) {
      lines.push(`- <@${userId}>: ${rankedLines.join(", ")}`);
    }
  }

  return lines;
}

function truncateAnnouncement(content: string) {
  const maxLength = 1024;
  if (content.length <= maxLength) return content;

  return `${content.slice(0, maxLength - 40)}\n...vote list truncated.`;
}

function formatPollType(poll: PollDocument) {
  return poll.pollType === "ranked" ? "Ranked poll" : "Regular poll";
}

async function announcePollWinner(client: Client, poll: PollDocument, winner: PollDocument["winner"], scoreText: string) {
  if (!winner) return;

  const channel = await client.channels.fetch(poll.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;

  const voteRevealLines = buildVoteRevealLines(poll);
  const voteRevealText =
    voteRevealLines.length > 0 ? truncateAnnouncement(voteRevealLines.join("\n")) : "No valid votes were recorded.";

  const embed = new EmbedBuilder()
    .setColor(0x6f8f72)
    .setTitle("Book Club Poll Winner")
    .setDescription(`**${winner.title}**${winner.author ? `\nby **${winner.author}**` : ""}`)
    .addFields(
      { name: "Final score", value: scoreText, inline: true },
      { name: "Poll type", value: formatPollType(poll), inline: true },
      { name: "Nominated by", value: `<@${winner.nominatedBy}>`, inline: true },
      { name: "Votes", value: voteRevealText },
    )
    .setTimestamp();

  if (winner.imageUrl) {
    embed.setImage(winner.imageUrl);
  }

  await channel.send({
    content: `@everyone The book poll is over. **${formatBookTitle(winner.title, winner.author)}** won and has been added to the club list.`,
    embeds: [embed],
    allowedMentions: {
      parse: ["everyone"],
      users: [winner.nominatedBy],
    },
  });
}

export async function closeActiveBookPolls(options: CloseActiveBookPollsOptions): Promise<CloseActiveBookPollsResult> {
  const { books, nominations, polls } = getBookClubCollections();
  const now = options.now ?? new Date();
  const addWinners = options.addWinners ?? false;
  const query: Record<string, unknown> = {
    status: "active",
  };

  if (options.guildId !== undefined) {
    query.guildId = options.guildId;
  }

  if (options.overdueOnly) {
    query.closesAt = { $lte: now };
  }

  const activePolls = await polls.find(query).sort({ createdAt: 1 }).toArray();
  const summaries: string[] = [];
  const closedGuildIds = new Set<string | null>();

  for (const poll of activePolls) {
    const { highestVoteCount, winners } = getWinningOptions(poll);
    const scoreLabel = poll.pollType === "ranked" ? "point" : "vote";
    const winner = winners.length === 1 ? winners[0] : null;
    closedGuildIds.add(poll.guildId);

    if (winner && addWinners) {
      await books.updateOne(
        {
          documentType: "book",
          guildId: poll.guildId,
          normalizedTitle: winner.normalizedTitle,
        },
        {
          $set: {
            documentType: "book",
            guildId: poll.guildId,
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
        { nominationId: winner.nominationId, guildId: poll.guildId },
        { $set: { status: "selected", updatedAt: now } },
      );
    }

    const closedPoll: PollDocument = {
      ...poll,
      status: "closed",
      winner,
      closedAt: now,
      updatedAt: now,
    };

    await polls.updateOne(
      { pollId: poll.pollId, guildId: poll.guildId },
      {
        $set: {
          status: "closed",
          winner,
          closedAt: now,
          updatedAt: now,
        },
      },
    );

    await updatePollMessage(options.client, poll, closedPoll);

    if (winner && addWinners) {
      const scoreText = `${highestVoteCount} ${scoreLabel}${highestVoteCount === 1 ? "" : "s"}`;
      await announcePollWinner(options.client, poll, winner, scoreText);

      summaries.push(
        `- Closed \`${poll.pollId}\`: added **${formatBookTitle(winner.title, winner.author)}** with ${scoreText}.`,
      );
    } else if (winner) {
      summaries.push(
        `- Closed \`${poll.pollId}\`: did not add **${formatBookTitle(
          winner.title,
          winner.author,
        )}** because this poll was closed manually.`,
      );
    } else if (winners.length > 1) {
      const tiedBooks = winners.map((tiedWinner) => `**${formatBookTitle(tiedWinner.title, tiedWinner.author)}**`).join(", ");
      summaries.push(`- Closed \`${poll.pollId}\`: no book added because there was a tie between ${tiedBooks}.`);
    } else {
      summaries.push(`- Closed \`${poll.pollId}\`: no book added because nobody voted.`);
    }
  }

  let clearedNominationCount = 0;
  for (const guildId of closedGuildIds) {
    const result = await nominations.deleteMany({
      documentType: "nomination",
      guildId,
    });
    clearedNominationCount += result.deletedCount;
  }

  return {
    closedCount: activePolls.length,
    clearedNominationCount,
    summaries,
  };
}

export async function closeOverdueBookPolls(client: Client) {
  return closeActiveBookPolls({
    addWinners: true,
    client,
    overdueOnly: true,
  });
}
