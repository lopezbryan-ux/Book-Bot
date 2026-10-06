import { AttachmentBuilder, Client, EmbedBuilder } from "discord.js";
import { formatBookTitle, getBookClubCollections, PollDocument } from "./book-club.js";
import { getValidPollVotes, getWinningOptions, refreshPollMessage } from "./polls.js";
import { mongoClient } from "./mongo.js";
import { invalidateRatingViewsCache } from "./rating-views.js";

interface CloseActiveBookPollsOptions {
  client: Client;
  addWinners?: boolean;
  createdBy?: string;
  guildId?: string | null;
  overdueOnly?: boolean;
  pollId?: string;
  now?: Date;
}

export interface CloseActiveBookPollsResult {
  closedCount: number;
  clearedNominationCount: number;
  summaries: string[];
}

const MAX_VOTERS_PER_ANNOUNCEMENT = 4;

function buildVoteRevealLines(poll: PollDocument) {
  const lines: string[] = [];

  for (const [userId, vote] of getValidPollVotes(poll)) {
    if (typeof vote === "number") {
      const option = poll.options[vote];
      if (!option) continue;

      lines.push(`- <@${userId}> voted for **${formatBookTitle(option.title, option.author)}**: 1 point`);
      continue;
    }

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

function groupVoteRevealLines(lines: string[]) {
  const pages: string[] = [];
  let pageLines: string[] = [];
  let pageLength = 0;

  for (const line of lines) {
    const nextLength = pageLength + (pageLines.length > 0 ? 1 : 0) + line.length;
    if (pageLines.length > 0 && (pageLines.length >= MAX_VOTERS_PER_ANNOUNCEMENT || nextLength > 1024)) {
      pages.push(pageLines.join("\n"));
      pageLines = [];
      pageLength = 0;
    }
    pageLength += (pageLines.length > 0 ? 1 : 0) + line.length;
    pageLines.push(line);
  }

  if (pageLines.length > 0) pages.push(pageLines.join("\n"));
  return pages;
}

function addAnnouncementSection(embed: EmbedBuilder, name: string, value: string, fileName: string) {
  if (value.length <= 1024 && embed.length + name.length + value.length <= 6000) {
    embed.addFields({ name, value });
    return [];
  }

  const description = `${embed.data.description ? `${embed.data.description}\n\n` : ""}**${name}**\n${value}`;
  if (description.length <= 4096 && embed.length - (embed.data.description?.length ?? 0) + description.length <= 6000) {
    embed.setDescription(description);
    return [];
  }

  // Exceptionally long sections stay complete in a text attachment.
  embed.addFields({ name, value: `See the attached file for the complete ${name.toLowerCase()}.` });
  return [new AttachmentBuilder(Buffer.from(value, "utf8"), { name: fileName })];
}

function splitAnnouncement(content: string, maxLength: number) {
  const chunks: string[] = [];

  while (content.length > maxLength) {
    // Keep whole ballots together when possible, and retain every character.
    let end = content.lastIndexOf("\n", maxLength - 1) + 1;
    if (end === 0) {
      const lastComma = content.lastIndexOf(", ", maxLength - 2);
      if (lastComma >= 0) end = lastComma + 2;
    }
    if (end === 0) end = content.lastIndexOf(" ", maxLength - 1) + 1;
    if (end === 0) end = maxLength;
    // A hard split must not separate the two halves of an emoji.
    const lastCodeUnit = content.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;

    chunks.push(content.slice(0, end));
    content = content.slice(end);
  }

  if (content) chunks.push(content);
  return chunks;
}

function formatPollType(poll: PollDocument) {
  return poll.pollType === "ranked" ? "Ranked poll" : "Regular poll";
}

function buildTiedBookVoteText(poll: PollDocument, tiedOptionIndexes: number[], scoreText: string) {
  const votes = getValidPollVotes(poll);

  return tiedOptionIndexes
    .map((optionIndex) => {
      const option = poll.options[optionIndex];
      if (!option) return null;

      const voters = votes.flatMap(([userId, vote]) => {
        if (typeof vote === "number") {
          return vote === optionIndex ? [`<@${userId}>`] : [];
        }

        const rank = [
          { optionIndex: vote.first, label: "#1", points: 3 },
          { optionIndex: vote.second, label: "#2", points: 2 },
          { optionIndex: vote.third, label: "#3", points: 1 },
        ].find((choice) => choice.optionIndex === optionIndex);

        return rank ? [`<@${userId}> (${rank.label}, ${rank.points} point${rank.points === 1 ? "" : "s"})`] : [];
      });

      return `**${formatBookTitle(option.title, option.author)}** - ${scoreText}\nVoters: ${voters.join(", ") || "No valid voters recorded"}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

async function announcePollWinner(client: Client, poll: PollDocument, winner: PollDocument["winner"], scoreText: string) {
  if (!winner) return;

  const channel = await client.channels.fetch(poll.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;

  const voteRevealLines = buildVoteRevealLines(poll);
  const voteRevealPages = voteRevealLines.length > 0
    ? groupVoteRevealLines(voteRevealLines)
    : ["No valid votes were recorded."];

  const embed = new EmbedBuilder()
    .setColor(0x6f8f72)
    .setTitle("Book Club Poll Winner")
    .setDescription(`**${winner.title}**${winner.author ? `\nby **${winner.author}**` : ""}`)
    .addFields(
      { name: "Final score", value: scoreText, inline: true },
      { name: "Poll type", value: formatPollType(poll), inline: true },
      { name: "Nominated by", value: `<@${winner.nominatedBy}>`, inline: true },
    )
    .setTimestamp();

  if (winner.imageUrl) {
    embed.setImage(winner.imageUrl);
  }

  const { counts } = getWinningOptions(poll);
  const otherScores = counts.filter((_, index) => poll.options[index].nominationId !== winner.nominationId);
  const runnerUpScore = otherScores.length > 0 ? Math.max(...otherScores) : null;
  const runnersUp = poll.options.filter((option, index) =>
    option.nominationId !== winner.nominationId && counts[index] === runnerUpScore,
  );
  const scoreLabel = poll.pollType === "ranked" ? "point" : "vote";
  const runnerUpText = runnersUp.length > 0
    ? runnersUp.map((option) =>
      `**${formatBookTitle(option.title, option.author)}** - ${runnerUpScore} ${scoreLabel}${runnerUpScore === 1 ? "" : "s"}`,
    ).join("\n")
    : "No other books were nominated.";
  const runnerUpFiles = addAnnouncementSection(
    embed,
    runnersUp.length > 1 ? "Runners-up (tied)" : "Runner-up",
    runnerUpText,
    "book-poll-runners-up.txt",
  );

  for (const [index, value] of voteRevealPages.entries()) {
    const announcementEmbed = index === 0
      ? embed
      : new EmbedBuilder()
        .setColor(0x6f8f72)
        .setTitle("Book Club Poll Votes (continued)")
        .setTimestamp();
    const voteFiles = addAnnouncementSection(announcementEmbed, "Votes", value, "book-poll-ballot.txt");
    const files = index === 0 ? [...runnerUpFiles, ...voteFiles] : voteFiles;

    await channel.send({
      content: index === 0
        ? `@everyone The book poll is over. **${formatBookTitle(winner.title, winner.author)}** won and has been added to the club list.`
        : undefined,
      embeds: [announcementEmbed],
      files,
      allowedMentions: index === 0
        ? { parse: ["everyone"], users: [winner.nominatedBy] }
        : { parse: [] },
    });
  }
}

async function announcePollTie(
  client: Client,
  poll: PollDocument,
  tiedOptionIndexes: number[],
  scoreText: string,
) {
  const channel = await client.channels.fetch(poll.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;

  const tiedBookVoteText = buildTiedBookVoteText(poll, tiedOptionIndexes, scoreText);
  for (const [index, description] of splitAnnouncement(tiedBookVoteText, 4096).entries()) {
    const embed = new EmbedBuilder()
      .setColor(0xd6a84b)
      .setTitle(index === 0 ? "Book Club Poll Tie" : "Book Club Poll Tie (continued)")
      .setDescription(description)
      .addFields({ name: "Poll type", value: formatPollType(poll), inline: true })
      .setTimestamp();

    await channel.send({
      content: index === 0 ? "@everyone The book poll is over. It ended in a tie, so no book was added." : undefined,
      embeds: [embed],
      allowedMentions: { parse: index === 0 ? ["everyone"] : [] },
    });
  }
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

  if (options.createdBy !== undefined) {
    query.createdBy = options.createdBy;
  }

  if (options.pollId !== undefined) {
    query.pollId = options.pollId;
  }

  if (options.overdueOnly) {
    query.closesAt = { $lte: now };
  }

  const activePolls = await polls.find(query).sort({ createdAt: 1 }).toArray();
  const summaries: string[] = [];
  let closedCount = 0;
  let clearedNominationCount = 0;

  for (const candidate of activePolls) {
    const result = await mongoClient.withSession((session) => session.withTransaction(async () => {
      // Re-read inside the transaction. A vote arriving after the initial scan
      // must either be included here or cause a write conflict and a fresh retry.
      const poll = await polls.findOne({ ...query, pollId: candidate.pollId, guildId: candidate.guildId }, { session });
      if (!poll) return null;

      const { highestVoteCount, winners } = getWinningOptions(poll);
      const winner = winners.length === 1 ? winners[0] : null;
      const closedAt = options.now ?? new Date();
      const closedPoll: PollDocument = { ...poll, status: "closed", winner, closedAt, updatedAt: closedAt };
      const update = await polls.updateOne(
        { pollId: poll.pollId, guildId: poll.guildId, status: "active" },
        { $set: { status: "closed", winner, closedAt, updatedAt: closedAt } },
        { session },
      );
      if (update.matchedCount === 0) return null;

      if (winner && addWinners) {
        await books.updateOne(
          { documentType: "book", guildId: poll.guildId, normalizedTitle: winner.normalizedTitle },
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
              selectedAt: closedAt,
              updatedAt: closedAt,
            },
          },
          { upsert: true, session },
        );
        await nominations.updateOne(
          { nominationId: winner.nominationId, guildId: poll.guildId },
          { $set: { status: "selected", updatedAt: closedAt } },
          { session },
        );
      }

      const cleared = await nominations.deleteMany({
        documentType: "nomination",
        guildId: poll.guildId,
        nominationId: { $in: poll.options.map((option) => option.nominationId) },
      }, { session });
      return { poll: closedPoll, highestVoteCount, winners, clearedCount: cleared.deletedCount };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
    if (!result) continue;

    const { poll, highestVoteCount, winners } = result;
    const winner = poll.winner;
    closedCount += 1;
    clearedNominationCount += result.clearedCount;
    const scoreLabel = poll.pollType === "ranked" ? "point" : "vote";
    const tiedOptionIndexes =
      winners.length > 1
        ? poll.options.flatMap((option, index) =>
            winners.some((tiedWinner) => tiedWinner.nominationId === option.nominationId) ? [index] : [],
          )
        : [];
    if (winner && addWinners) invalidateRatingViewsCache(poll.guildId);
    // External effects only run after the transaction has committed successfully.
    await refreshPollMessage(options.client, poll);

    const scoreText = `${highestVoteCount} ${scoreLabel}${highestVoteCount === 1 ? "" : "s"}`;

    if (winner && addWinners) {
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
      await announcePollTie(options.client, poll, tiedOptionIndexes, scoreText);

      const tiedBooks = winners.map((tiedWinner) => `**${formatBookTitle(tiedWinner.title, tiedWinner.author)}**`).join(", ");
      summaries.push(`- Closed \`${poll.pollId}\`: no book added because there was a tie between ${tiedBooks}.`);
    } else {
      summaries.push(`- Closed \`${poll.pollId}\`: no book added because no valid votes were recorded.`);
    }
  }

  return {
    closedCount,
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
