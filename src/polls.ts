import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { getBookClubCollections, PollDocument, PollOption, PollType, RankedPollVote, formatBookTitle } from "./book-club.js";
import { isPollOpen, openPollFilter } from "./poll-state.js";

const POLL_VOTE_PREFIX = "book-poll:vote";
const POLL_RANK_PREFIX = "book-poll:rank";
const POLL_RANK_OPEN_PREFIX = "book-poll:rank-open";
const POLL_PAGE_PREFIX = "book-poll:page";
const RANK_KEYS = ["first", "second", "third"] as const;
const RANK_WEIGHTS = [3, 2, 1] as const;
const POLL_OPTIONS_PER_PAGE = 20;
const REGULAR_POLL_BAR_SEGMENTS = 12;
const MAX_VISIBLE_VOTERS_PER_OPTION = 4;
const ACTIVE_POLL_COLOR = 0x5865f2;
const CLOSED_POLL_COLOR = 0x747f8d;

type PollComponentRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
type PollComponentPoll = Pick<PollDocument, "options" | "pollId" | "pollType" | "votes" | "status" | "closesAt">;
const pollMessageUpdates = new Map<string, Promise<void>>();

export function buildPollCustomId(pollId: string, nominationId: string, page: number) {
  return `${POLL_VOTE_PREFIX}:${pollId}:${nominationId}:${page}`;
}

export function buildPollRankCustomId(pollId: string, rankIndex: number, page: number) {
  return `${POLL_RANK_PREFIX}:${pollId}:${rankIndex}:${page}`;
}

export function buildPollRankOpenCustomId(pollId: string, page: number) {
  return `${POLL_RANK_OPEN_PREFIX}:${pollId}:${page}`;
}

export function buildPollPageCustomId(pollId: string, page: number) {
  return `${POLL_PAGE_PREFIX}:${pollId}:${page}`;
}

export function isBookPollVoteCustomId(customId: string) {
  return customId.startsWith(`${POLL_VOTE_PREFIX}:`);
}

export function isBookPollRankCustomId(customId: string) {
  return customId.startsWith(`${POLL_RANK_PREFIX}:`);
}

export function isBookPollRankOpenCustomId(customId: string) {
  return customId.startsWith(`${POLL_RANK_OPEN_PREFIX}:`);
}

export function isBookPollPageCustomId(customId: string) {
  return customId.startsWith(`${POLL_PAGE_PREFIX}:`);
}

function getPollType(poll: Pick<PollDocument, "pollType">): PollType {
  return poll.pollType ?? "regular";
}

function getPollTotalPages(poll: Pick<PollDocument, "options">) {
  return Math.max(1, Math.ceil(poll.options.length / POLL_OPTIONS_PER_PAGE));
}

function getSafePollPage(poll: Pick<PollDocument, "options">, page: number) {
  return Math.min(Math.max(page, 0), getPollTotalPages(poll) - 1);
}

function getPollPageOptions(poll: Pick<PollDocument, "options">, page: number) {
  const safePage = getSafePollPage(poll, page);
  const startIndex = safePage * POLL_OPTIONS_PER_PAGE;
  return {
    safePage,
    startIndex,
    options: poll.options.slice(startIndex, startIndex + POLL_OPTIONS_PER_PAGE),
  };
}

function truncateMenuText(value: string, maxLength = 100) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isRankedPollVote(value: unknown): value is RankedPollVote {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRankedChoices(vote: RankedPollVote) {
  return RANK_KEYS.map((rankKey) => vote[rankKey]);
}

function hasDuplicateRankedChoices(vote: RankedPollVote) {
  const choices = getRankedChoices(vote).filter((choice): choice is number => typeof choice === "number");
  return new Set(choices).size !== choices.length;
}

function isCompleteRankedVote(vote: RankedPollVote, optionCount: number) {
  const choices = getRankedChoices(vote);
  return (
    choices.every((choice) => typeof choice === "number" && Number.isInteger(choice) && choice >= 0 && choice < optionCount) &&
    !hasDuplicateRankedChoices(vote)
  );
}

function getRankedVoteForUser(poll: Pick<PollDocument, "votes">, userId?: string) {
  if (!userId) return null;

  const vote = poll.votes?.[userId];
  return isRankedPollVote(vote) ? vote : null;
}

function getRankedChoiceForUser(poll: Pick<PollDocument, "options" | "votes">, rankIndex: number, userId?: string) {
  const vote = getRankedVoteForUser(poll, userId);
  if (!vote) return null;

  const choice = vote[RANK_KEYS[rankIndex]];
  return typeof choice === "number" && Number.isInteger(choice) && choice >= 0 && choice < poll.options.length ? choice : null;
}

function getRankedChoicePlaceholder(poll: Pick<PollDocument, "options">, rankIndex: number, selectedOptionIndex: number | null) {
  const option = typeof selectedOptionIndex === "number" ? poll.options[selectedOptionIndex] : null;
  if (!option) return `Choose your #${rankIndex + 1} book`;

  return truncateMenuText(`#${rankIndex + 1}: ${formatBookTitle(option.title, option.author)}`, 150);
}

function formatScore(value: number, pollType: PollType) {
  const label = pollType === "ranked" ? "point" : "vote";
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

function getRegularPollVotersByOption(poll: Pick<PollDocument, "options" | "votes">) {
  const votersByOption = Array.from({ length: poll.options.length }, () => [] as string[]);

  for (const [userId, optionIndex] of Object.entries(poll.votes ?? {})) {
    if (typeof optionIndex === "number" && Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < votersByOption.length) {
      votersByOption[optionIndex].push(userId);
    }
  }

  return votersByOption;
}

function buildRegularPollBar(voteCount: number, totalVotes: number) {
  const filledSegments =
    voteCount === 0 ? 0 : Math.max(1, Math.round((voteCount / totalVotes) * REGULAR_POLL_BAR_SEGMENTS));
  return `${"█".repeat(filledSegments)}${"░".repeat(REGULAR_POLL_BAR_SEGMENTS - filledSegments)}`;
}

function formatRegularPollVoters(voters: string[]) {
  if (voters.length === 0) return "No votes yet";

  const visibleVoters = voters.slice(0, MAX_VISIBLE_VOTERS_PER_OPTION).map((userId) => `<@${userId}>`);
  const hiddenCount = voters.length - visibleVoters.length;
  return hiddenCount > 0 ? `${visibleVoters.join(", ")} and ${hiddenCount} more` : visibleVoters.join(", ");
}

function buildRegularPollDescription(
  poll: Pick<PollDocument, "options" | "votes">,
  options: PollOption[],
  startIndex: number,
  scores: number[],
) {
  const votersByOption = getRegularPollVotersByOption(poll);
  const totalVotes = votersByOption.reduce((sum, voters) => sum + voters.length, 0);

  return options
    .map((option, index) => {
      const optionIndex = startIndex + index;
      const nomination = formatBookTitle(option.title, option.author);
      const cover = option.imageUrl ? ` ([cover](${option.imageUrl}))` : "";
      const score = scores[optionIndex] ?? 0;
      const percentage = totalVotes === 0 ? 0 : Math.round((score / totalVotes) * 100);
      const voters = votersByOption[optionIndex] ?? [];

      return [
        `**${optionIndex + 1}  ·  ${nomination}**${cover}`,
        `\`${buildRegularPollBar(score, totalVotes)}\` ${formatScore(score, "regular")} - ${percentage}%`,
        `↳ ${formatRegularPollVoters(voters)}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildHiddenPollDescription(options: PollOption[], startIndex: number) {
  return options
    .map((option, index) => {
      const optionIndex = startIndex + index;
      const nomination = formatBookTitle(option.title, option.author);
      const cover = option.imageUrl ? ` ([cover](${option.imageUrl}))` : "";

      return `**${optionIndex + 1}  ·  ${nomination}**${cover}`;
    })
    .join("\n\n");
}

function buildRankedStatus(poll: Pick<PollDocument, "votes" | "options">) {
  const ballots = Object.values(poll.votes ?? {}).filter(isRankedPollVote);
  const completeBallots = ballots.filter((vote) => isCompleteRankedVote(vote, poll.options.length)).length;

  return `${completeBallots} complete ballot${completeBallots === 1 ? "" : "s"}`;
}

interface RankedOptionVoter {
  userId: string;
  rank: number;
  points: number;
}

function getRankedPollVotersByOption(poll: Pick<PollDocument, "options" | "votes">) {
  const votersByOption = Array.from({ length: poll.options.length }, () => [] as RankedOptionVoter[]);

  for (const [userId, vote] of Object.entries(poll.votes ?? {})) {
    if (!isRankedPollVote(vote) || !isCompleteRankedVote(vote, poll.options.length)) continue;

    for (const [rankIndex, optionIndex] of getRankedChoices(vote).entries()) {
      if (typeof optionIndex !== "number") continue;

      votersByOption[optionIndex]?.push({
        userId,
        rank: rankIndex + 1,
        points: RANK_WEIGHTS[rankIndex] ?? 0,
      });
    }
  }

  return votersByOption;
}

function formatRankedPollVoters(voters: RankedOptionVoter[]) {
  if (voters.length === 0) return "No votes yet";

  const visibleVoters = voters
    .slice(0, MAX_VISIBLE_VOTERS_PER_OPTION)
    .map(({ userId, rank, points }) => `<@${userId}> (#${rank}, ${points} pt${points === 1 ? "" : "s"})`);
  const hiddenCount = voters.length - visibleVoters.length;
  return hiddenCount > 0 ? `${visibleVoters.join(", ")} and ${hiddenCount} more` : visibleVoters.join(", ");
}

function buildRankedPollDescription(
  poll: Pick<PollDocument, "options" | "votes">,
  options: PollOption[],
  startIndex: number,
  scores: number[],
) {
  const votersByOption = getRankedPollVotersByOption(poll);

  return options
    .map((option, index) => {
      const optionIndex = startIndex + index;
      const nomination = formatBookTitle(option.title, option.author);
      const cover = option.imageUrl ? ` ([cover](${option.imageUrl}))` : "";
      const score = scores[optionIndex] ?? 0;
      const voters = votersByOption[optionIndex] ?? [];

      return [
        `**${optionIndex + 1}  ·  ${nomination}**${cover}`,
        `⭐ ${formatScore(score, "ranked")}  ·  ${formatRankedPollVoters(voters)}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatPollCloseTime(closesAt?: Date | string | null) {
  if (!closesAt) return "Manual close";

  const closeDate = closesAt instanceof Date ? closesAt : new Date(closesAt);
  if (Number.isNaN(closeDate.getTime())) return "Manual close";

  const unixTimestamp = Math.floor(closeDate.getTime() / 1000);
  return `<t:${unixTimestamp}:f> (<t:${unixTimestamp}:R>)`;
}

function buildPollInstructions(pollType: PollType, isActive: boolean) {
  if (!isActive) return "Voting has ended. Here are the final results.";

  return pollType === "ranked"
    ? "Rank your **top three books**. First place earns 3 points, second earns 2, and third earns 1. Votes and results stay hidden until the poll ends."
    : "Choose **one book** using its numbered button below. You can change your vote any time before the poll closes. Votes and results stay hidden until the poll ends.";
}

function buildParticipationText(poll: Pick<PollDocument, "options" | "pollType" | "votes">) {
  if (getPollType(poll) === "ranked") return buildRankedStatus(poll);

  const voteCount = Object.values(poll.votes ?? {}).filter(
    (vote) => typeof vote === "number" && Number.isInteger(vote) && vote >= 0 && vote < poll.options.length,
  ).length;
  return `${voteCount} vote${voteCount === 1 ? "" : "s"} cast`;
}

export function buildPollEmbed(
  poll: Pick<PollDocument, "closedAt" | "closesAt" | "options" | "pollId" | "pollType" | "votes" | "status">,
  page = 0,
) {
  const pollType = getPollType(poll);
  const totalPages = getPollTotalPages(poll);
  const { safePage, startIndex, options } = getPollPageOptions(poll, page);
  const isActive = isPollOpen(poll);
  const scores = isActive ? [] : getPollScores(poll);
  const results =
    poll.options.length === 0
      ? "*No books have been nominated yet. Use `/nominate-book` to add the first one.*"
      : isActive
        ? buildHiddenPollDescription(options, startIndex)
        : pollType === "regular"
          ? buildRegularPollDescription(poll, options, startIndex, scores)
          : buildRankedPollDescription(poll, options, startIndex, scores);
  const description = `${buildPollInstructions(pollType, isActive)}\n\n${results}`;
  const votingStyle = pollType === "ranked" ? "Rank your top 3 · 3–2–1 points" : "Pick one book";
  const footerText =
    totalPages > 1 ? `Poll ID · ${poll.pollId}  •  Page ${safePage + 1} of ${totalPages}` : `Poll ID · ${poll.pollId}`;

  return new EmbedBuilder()
    .setColor(isActive ? ACTIVE_POLL_COLOR : CLOSED_POLL_COLOR)
    .setTitle(isActive ? "📚  Vote for Our Next Book" : "📕  Book Poll Closed")
    .setDescription(description)
    .addFields(
      { name: "🗳️  Voting style", value: votingStyle, inline: true },
      {
        name: isActive ? "⏳  Poll closes" : "✅  Poll closed",
        value: formatPollCloseTime(isActive ? poll.closesAt : (poll.closedAt ?? poll.closesAt)),
        inline: true,
      },
      {
        name: "👥  Participation",
        value: buildParticipationText(poll),
        inline: true,
      },
    )
    .setFooter({ text: footerText });
}

export function buildPollComponents(poll: PollComponentPoll, disabled = false, page = 0, viewerUserId?: string) {
  if (poll.options.length === 0) return [];
  disabled = disabled || !isPollOpen(poll);

  return getPollType(poll) === "ranked"
    ? viewerUserId
      ? buildRankedPollBallotComponents(poll, disabled, page, viewerUserId)
      : buildRankedPollOpenComponents(poll, disabled, page)
    : buildRegularPollComponents(poll, disabled, page);
}

function buildRegularPollComponents(poll: Pick<PollDocument, "options" | "pollId">, disabled = false, page = 0) {
  const rows: PollComponentRow[] = [];
  const totalPages = getPollTotalPages(poll);
  const { safePage, startIndex, options } = getPollPageOptions(poll, page);

  for (let index = 0; index < options.length; index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const rowOptions = options.slice(index, index + 5);

    for (const [offset, option] of rowOptions.entries()) {
      const optionIndex = startIndex + index + offset;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildPollCustomId(poll.pollId, option.nominationId, safePage))
          .setLabel(`Vote ${optionIndex + 1}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
      );
    }

    rows.push(row);
  }

  if (!disabled && totalPages > 1) {
    rows.push(buildPollPageRow(poll.pollId, safePage, totalPages));
  }

  return rows;
}

function buildRankedPollOpenComponents(poll: Pick<PollDocument, "options" | "pollId">, disabled = false, page = 0) {
  const rows: PollComponentRow[] = [];
  const totalPages = getPollTotalPages(poll);
  const safePage = getSafePollPage(poll, page);

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildPollRankOpenCustomId(poll.pollId, safePage))
        .setLabel("Rank my top 3")
        .setEmoji("🏆")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );

  if (!disabled && totalPages > 1) {
    rows.push(buildPollPageRow(poll.pollId, safePage, totalPages));
  }

  return rows;
}

function buildRankedPollBallotComponents(
  poll: Pick<PollDocument, "options" | "pollId" | "votes">,
  disabled = false,
  page = 0,
  viewerUserId: string,
) {
  const rows: PollComponentRow[] = [];
  const totalPages = getPollTotalPages(poll);
  const { safePage, startIndex, options: pageOptions } = getPollPageOptions(poll, page);

  for (let rankIndex = 0; rankIndex < RANK_KEYS.length; rankIndex += 1) {
    const selectedOptionIndex = getRankedChoiceForUser(poll, rankIndex, viewerUserId);
    const options = pageOptions.map((option, index) => {
      const optionIndex = startIndex + index;
      return {
        default: optionIndex === selectedOptionIndex,
        label: truncateMenuText(`${optionIndex + 1}. ${formatBookTitle(option.title, option.author)}`),
        value: option.nominationId,
      };
    });

    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildPollRankCustomId(poll.pollId, rankIndex, safePage))
          .setPlaceholder(getRankedChoicePlaceholder(poll, rankIndex, selectedOptionIndex))
          .setMinValues(1)
          .setMaxValues(1)
          .setOptions(options)
          .setDisabled(disabled),
      ),
    );
  }

  if (!disabled && totalPages > 1) {
    rows.push(buildPollPageRow(poll.pollId, safePage, totalPages));
  }

  return rows;
}

function buildPollPageRow(pollId: string, safePage: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildPollPageCustomId(pollId, safePage - 1))
      .setLabel("Previous")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(buildPollPageCustomId(pollId, safePage))
      .setLabel(`Page ${safePage + 1} of ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(buildPollPageCustomId(pollId, safePage + 1))
      .setLabel("Next")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );
}

function isEphemeralMessageInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  return interaction.message.flags.has(MessageFlags.Ephemeral);
}

export async function refreshPollMessage(client: Client, poll: PollDocument, page = 0) {
  if (!poll.messageId) return;
  const key = `${poll.guildId}:${poll.pollId}`;
  const previous = pollMessageUpdates.get(key) ?? Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (!channel?.isTextBased() || !("messages" in channel)) return;

    const pollMessage = await channel.messages.fetch(poll.messageId!).catch(() => null);
    if (!pollMessage) return;

    const { polls } = getBookClubCollections();
    const latestPoll = await polls.findOne({ pollId: poll.pollId, guildId: poll.guildId });
    if (!latestPoll) return;

    await pollMessage.edit({
      embeds: [buildPollEmbed(latestPoll, page)],
      components: buildPollComponents(latestPoll, false, page),
    });
  });
  pollMessageUpdates.set(key, update);
  try {
    await update;
  } finally {
    if (pollMessageUpdates.get(key) === update) pollMessageUpdates.delete(key);
  }
}

function buildPrivateRankedBallot(poll: PollDocument, page: number, userId: string, content?: string) {
  if (!content) {
    const vote = getRankedVoteForUser(poll, userId);
    content = vote && !isCompleteRankedVote(vote, poll.options.length)
      ? "Your ballot does not count yet. Choose three different books that are still in this poll."
      : "Your ranked ballot for this poll:";
  }
  return {
    content,
    embeds: [buildPollEmbed(poll, page)],
    components: buildPollComponents(poll, false, page, userId),
  };
}

export function getValidPollVotes(poll: Pick<PollDocument, "options" | "pollType" | "votes">) {
  const isRanked = getPollType(poll) === "ranked";

  return Object.entries(poll.votes ?? {}).filter(([, vote]) =>
    isRanked
      ? isRankedPollVote(vote) && isCompleteRankedVote(vote, poll.options.length)
      : typeof vote === "number" && Number.isInteger(vote) && vote >= 0 && vote < poll.options.length,
  );
}

export function getPollScores(poll: Pick<PollDocument, "options" | "pollType" | "votes">) {
  const scores = Array.from({ length: poll.options.length }, () => 0);

  for (const [, vote] of getValidPollVotes(poll)) {
    if (typeof vote === "number") {
      scores[vote] += 1;
      continue;
    }

    for (const [rankIndex, optionIndex] of getRankedChoices(vote).entries()) {
      if (typeof optionIndex === "number") {
        scores[optionIndex] += RANK_WEIGHTS[rankIndex] ?? 0;
      }
    }
  }

  return scores;
}

export function getWinningOptions(poll: Pick<PollDocument, "options" | "pollType" | "votes">) {
  const counts = getPollScores(poll);
  if (counts.length === 0) {
    return { counts, highestVoteCount: 0, winners: [] as PollOption[] };
  }

  const highestVoteCount = Math.max(...counts);

  if (highestVoteCount === 0) {
    return { counts, highestVoteCount, winners: [] as PollOption[] };
  }

  const winners = poll.options.filter((_, index) => counts[index] === highestVoteCount);
  return { counts, highestVoteCount, winners };
}

type SavePollVoteResult =
  | { ok: true; poll: PollDocument; selectedOption: PollOption }
  | { ok: false; poll?: PollDocument | null; error: string };

async function savePollVote(
  pollId: string,
  guildId: string | null,
  userId: string,
  nominationId: string,
  rankKey?: (typeof RANK_KEYS)[number],
): Promise<SavePollVoteResult> {
  const { polls } = getBookClubCollections();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const poll = await polls.findOne({ pollId, guildId });
    if (!poll || !isPollOpen(poll)) return { ok: false, poll, error: "Voting has ended for this poll." };

    if (getPollType(poll) !== (rankKey ? "ranked" : "regular")) {
      return { ok: false, poll, error: rankKey ? "Use the vote buttons for this regular poll." : "Use the ranking menus for this ranked poll." };
    }

    // Positional controls from an older deployment cannot identify their original book safely.
    if (/^\d+$/.test(nominationId)) {
      return { ok: false, poll, error: "This ballot is out of date. Choose again using the updated poll." };
    }

    const optionIndex = poll.options.findIndex((option) => option.nominationId === nominationId);
    const selectedOption = poll.options[optionIndex];
    if (!selectedOption) return { ok: false, poll, error: "That nomination is no longer available. Choose again using the updated poll." };

    const currentVote = poll.votes?.[userId];
    const vote = rankKey
      ? { ...(isRankedPollVote(currentVote) ? currentVote : {}), [rankKey]: optionIndex }
      : optionIndex;
    const updatedPoll = await polls.findOneAndUpdate(
      {
        ...openPollFilter(pollId, guildId),
        // A nomination edit/removal must not shift the meaning of this stored index.
        options: poll.options,
        ...(rankKey ? { [`votes.${userId}`]: currentVote === undefined ? { $exists: false } : currentVote } : {}),
      },
      { $set: { [`votes.${userId}`]: vote, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (updatedPoll) return { ok: true, poll: updatedPoll, selectedOption };
    // A concurrent rank edit or nomination change won. Re-read before trying again.
  }

  return { ok: false, error: "The poll changed while saving your vote. Please choose again." };
}

export async function handleBookPollVote(interaction: ButtonInteraction) {
  const [, , pollId, nominationId, pageText] = interaction.customId.split(":");
  const page = Number(pageText ?? 0);

  if (!pollId || !nominationId || !Number.isInteger(page)) {
    await interaction.reply({ content: "That poll vote button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await savePollVote(pollId, interaction.guildId, interaction.user.id, nominationId);
  await interaction.editReply({
    content: result.ok
      ? `Your vote for **${formatBookTitle(result.selectedOption.title, result.selectedOption.author)}** is counted.`
      : result.error,
  });
  if (result.poll) await refreshPollMessage(interaction.client, result.poll, page);
}

export async function handleBookPollRankOpen(interaction: ButtonInteraction) {
  const [, , pollId, pageText] = interaction.customId.split(":");
  const page = Number(pageText);

  if (!pollId || !Number.isInteger(page)) {
    await interaction.reply({ content: "That ranked poll button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { polls } = getBookClubCollections();
  const poll = await polls.findOne({ pollId, guildId: interaction.guildId });

  if (!poll || !isPollOpen(poll)) {
    await interaction.reply({ content: "Voting has ended for this poll.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (getPollType(poll) !== "ranked") {
    await interaction.reply({ content: "Use the vote buttons for this regular poll.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({
    ...buildPrivateRankedBallot(poll, page, interaction.user.id),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleBookPollRank(interaction: StringSelectMenuInteraction) {
  const [, , pollId, rankIndexText, pageText] = interaction.customId.split(":");
  const rankIndex = Number(rankIndexText);
  const nominationId = interaction.values[0];
  const page = Number(pageText);

  if (
    !pollId ||
    !Number.isInteger(rankIndex) ||
    !nominationId ||
    interaction.values.length !== 1 ||
    !Number.isInteger(page) ||
    !RANK_KEYS[rankIndex]
  ) {
    await interaction.reply({ content: "That ranked poll menu is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (isEphemeralMessageInteraction(interaction)) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await savePollVote(pollId, interaction.guildId, interaction.user.id, nominationId, RANK_KEYS[rankIndex]);
  const poll = result.poll;
  if (!result.ok) {
    await interaction.editReply(poll && getPollType(poll) === "ranked"
      ? buildPrivateRankedBallot(poll, page, interaction.user.id, result.error)
      : { content: result.error });
  } else {
    const { poll: savedPoll, selectedOption } = result;
    const rankedVote = getRankedVoteForUser(savedPoll, interaction.user.id) ?? {};
    const status = hasDuplicateRankedChoices(rankedVote)
      ? " Your ballot does not count yet. Pick three different books before the poll closes."
      : isCompleteRankedVote(rankedVote, savedPoll.options.length)
        ? " Your ranked ballot is complete."
        : " Your ballot does not count yet. Choose your remaining ranked picks before the poll closes.";
    await interaction.editReply(buildPrivateRankedBallot(savedPoll, page, interaction.user.id,
      `Your #${rankIndex + 1} choice is **${formatBookTitle(selectedOption.title, selectedOption.author)}**.${status}`));
  }
  if (poll) await refreshPollMessage(interaction.client, poll, page);
}

export async function handleBookPollPage(interaction: ButtonInteraction) {
  const [, , pollId, pageText] = interaction.customId.split(":");
  const page = Number(pageText);

  if (!pollId || !Number.isInteger(page)) {
    await interaction.reply({ content: "That poll page button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { polls } = getBookClubCollections();
  const poll = await polls.findOne({ pollId, guildId: interaction.guildId });

  if (!poll || !isPollOpen(poll)) {
    await interaction.reply({ content: "Voting has ended for this poll.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (getPollType(poll) === "ranked" && isEphemeralMessageInteraction(interaction)) {
    await interaction.update(buildPrivateRankedBallot(poll, page, interaction.user.id));
    return;
  }

  await interaction.deferUpdate();
  await refreshPollMessage(interaction.client, poll, page);
}
