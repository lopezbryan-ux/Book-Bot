import { Client } from "discord.js";
import { formatBookTitle, getBookClubCollections, PollDocument } from "./book-club.js";
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
      summaries.push(
        `- Closed \`${poll.pollId}\`: added **${formatBookTitle(winner.title, winner.author)}** with ${highestVoteCount} ${scoreLabel}${
          highestVoteCount === 1 ? "" : "s"
        }.`,
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
