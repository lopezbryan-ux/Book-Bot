import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { getBookClubCollections, PollDocument, PollOption, PollType, RankedPollVote, formatBookTitle } from "./book-club.js";

const POLL_VOTE_PREFIX = "book-poll:vote";
const POLL_RANK_PREFIX = "book-poll:rank";
const POLL_PAGE_PREFIX = "book-poll:page";
const RANK_KEYS = ["first", "second", "third"] as const;
const RANK_WEIGHTS = [3, 2, 1] as const;
const POLL_OPTIONS_PER_PAGE = 20;

type PollComponentRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
type PollComponentPoll = Pick<PollDocument, "options" | "pollId" | "pollType" | "votes">;

export function buildPollCustomId(pollId: string, optionIndex: number, page: number) {
  return `${POLL_VOTE_PREFIX}:${pollId}:${optionIndex}:${page}`;
}

export function buildPollRankCustomId(pollId: string, rankIndex: number, page: number) {
  return `${POLL_RANK_PREFIX}:${pollId}:${rankIndex}:${page}`;
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
    choices.every((choice) => typeof choice === "number" && choice >= 0 && choice < optionCount) &&
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
  return typeof choice === "number" && choice >= 0 && choice < poll.options.length ? choice : null;
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

function buildRankedStatus(poll: Pick<PollDocument, "votes" | "options">) {
  const ballots = Object.values(poll.votes ?? {}).filter(isRankedPollVote);
  const completeBallots = ballots.filter((vote) => isCompleteRankedVote(vote, poll.options.length)).length;

  return `${completeBallots} complete ranked ballot${completeBallots === 1 ? "" : "s"}`;
}

function formatPollCloseTime(closesAt?: Date | string | null) {
  if (!closesAt) return "Manual close";

  const closeDate = closesAt instanceof Date ? closesAt : new Date(closesAt);
  if (Number.isNaN(closeDate.getTime())) return "Manual close";

  const unixTimestamp = Math.floor(closeDate.getTime() / 1000);
  return `<t:${unixTimestamp}:f> (<t:${unixTimestamp}:R>)`;
}

export function buildPollEmbed(
  poll: Pick<PollDocument, "closesAt" | "options" | "pollId" | "pollType" | "votes" | "status">,
  page = 0,
) {
  const pollType = getPollType(poll);
  const scores = getPollScores(poll);
  const totalPages = getPollTotalPages(poll);
  const { safePage, startIndex, options } = getPollPageOptions(poll, page);
  const description =
    poll.options.length === 0
      ? "No books have been nominated yet. Use `/nominate-book` to add books to this poll."
      : options
          .map((option, index) => {
            const optionIndex = startIndex + index;
            const nomination = formatBookTitle(option.title, option.author);
            const cover = option.imageUrl ? ` ([cover](${option.imageUrl}))` : "";
            const score = scores[optionIndex] ?? 0;
            return `**${optionIndex + 1}.** ${nomination}${cover} - ${formatScore(score, pollType)}`;
          })
          .join("\n");

  const statusText = pollType === "ranked" ? `Ranked poll - ${buildRankedStatus(poll)}` : "Regular poll";
  const footerText =
    totalPages > 1 ? `Poll ID: ${poll.pollId} - Page ${safePage + 1} of ${totalPages}` : `Poll ID: ${poll.pollId}`;

  return new EmbedBuilder()
    .setTitle(poll.status === "active" ? "Book Club Poll" : "Closed Book Club Poll")
    .setDescription(description)
    .addFields({ name: "Type", value: statusText }, { name: "Closes", value: formatPollCloseTime(poll.closesAt) })
    .setFooter({ text: footerText });
}

export function buildPollComponents(poll: PollComponentPoll, disabled = false, page = 0, viewerUserId?: string) {
  if (poll.options.length === 0) return [];

  return getPollType(poll) === "ranked"
    ? buildRankedPollComponents(poll, disabled, page, viewerUserId)
    : buildRegularPollComponents(poll, disabled, page);
}

function buildRegularPollComponents(poll: Pick<PollDocument, "options" | "pollId">, disabled = false, page = 0) {
  const rows: PollComponentRow[] = [];
  const totalPages = getPollTotalPages(poll);
  const { safePage, startIndex, options } = getPollPageOptions(poll, page);

  for (let index = 0; index < options.length; index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const rowOptions = options.slice(index, index + 5);

    for (const [offset] of rowOptions.entries()) {
      const optionIndex = startIndex + index + offset;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildPollCustomId(poll.pollId, optionIndex, safePage))
          .setLabel(`${optionIndex + 1}`)
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

function buildRankedPollComponents(
  poll: Pick<PollDocument, "options" | "pollId" | "votes">,
  disabled = false,
  page = 0,
  viewerUserId?: string,
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
        value: String(optionIndex),
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
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(buildPollPageCustomId(pollId, safePage))
      .setLabel(`${safePage + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(buildPollPageCustomId(pollId, safePage + 1))
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );
}

function isEphemeralMessageInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction) {
  return interaction.message.flags.has(MessageFlags.Ephemeral);
}

async function refreshPublicPollMessage(interaction: ButtonInteraction | StringSelectMenuInteraction, poll: PollDocument, page = 0) {
  if (!poll.messageId) return;

  const channel =
    poll.channelId === interaction.channelId
      ? interaction.channel
      : await interaction.client.channels.fetch(poll.channelId).catch(() => null);

  if (!channel?.isTextBased() || !("messages" in channel)) return;

  const pollMessage = await channel.messages.fetch(poll.messageId).catch(() => null);
  await pollMessage?.edit({
    embeds: [buildPollEmbed(poll, page)],
    components: buildPollComponents(poll, false, page),
  });
}

export function getPollScores(poll: Pick<PollDocument, "options" | "pollType" | "votes">) {
  const scores = Array.from({ length: poll.options.length }, () => 0);

  if (getPollType(poll) === "ranked") {
    for (const vote of Object.values(poll.votes ?? {})) {
      if (!isRankedPollVote(vote) || !isCompleteRankedVote(vote, poll.options.length)) continue;

      const choices = getRankedChoices(vote);
      for (const [rankIndex, optionIndex] of choices.entries()) {
        if (typeof optionIndex === "number") {
          scores[optionIndex] += RANK_WEIGHTS[rankIndex] ?? 0;
        }
      }
    }

    return scores;
  }

  for (const optionIndex of Object.values(poll.votes ?? {})) {
    if (typeof optionIndex === "number" && Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < scores.length) {
      scores[optionIndex] += 1;
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

export async function handleBookPollVote(interaction: ButtonInteraction) {
  const [, , pollId, optionIndexText, pageText] = interaction.customId.split(":");
  const optionIndex = Number(optionIndexText);
  const page = Number(pageText ?? 0);

  if (!pollId || !Number.isInteger(optionIndex) || !Number.isInteger(page)) {
    await interaction.reply({ content: "That poll vote button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { polls } = getBookClubCollections();
  const poll = await polls.findOne({ pollId, guildId: interaction.guildId });

  if (!poll || poll.status !== "active") {
    await interaction.reply({ content: "That poll is no longer active.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (getPollType(poll) !== "regular") {
    await interaction.reply({ content: "Use the ranking menus for this ranked poll.", flags: MessageFlags.Ephemeral });
    return;
  }

  const selectedOption = poll.options[optionIndex];
  if (!selectedOption) {
    await interaction.reply({ content: "That book is not part of this poll.", flags: MessageFlags.Ephemeral });
    return;
  }

  await polls.updateOne(
    { pollId, guildId: interaction.guildId },
    {
      $set: {
        [`votes.${interaction.user.id}`]: optionIndex,
        updatedAt: new Date(),
      },
    },
  );

  const updatedPoll = await polls.findOne({ pollId, guildId: interaction.guildId });
  if (updatedPoll) {
    await interaction.update({
      embeds: [buildPollEmbed(updatedPoll, page)],
      components: buildPollComponents(updatedPoll, false, page),
    });

    await interaction.followUp({
      content: `Your vote for **${formatBookTitle(selectedOption.title, selectedOption.author)}** is counted.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Your vote for **${formatBookTitle(selectedOption.title, selectedOption.author)}** is counted.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleBookPollRank(interaction: StringSelectMenuInteraction) {
  const [, , pollId, rankIndexText, pageText] = interaction.customId.split(":");
  const rankIndex = Number(rankIndexText);
  const optionIndex = Number(interaction.values[0]);
  const page = Number(pageText);

  if (
    !pollId ||
    !Number.isInteger(rankIndex) ||
    !Number.isInteger(optionIndex) ||
    !Number.isInteger(page) ||
    !RANK_KEYS[rankIndex]
  ) {
    await interaction.reply({ content: "That ranked poll menu is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { polls } = getBookClubCollections();
  const poll = await polls.findOne({ pollId, guildId: interaction.guildId });

  if (!poll || poll.status !== "active") {
    await interaction.reply({ content: "That poll is no longer active.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (getPollType(poll) !== "ranked") {
    await interaction.reply({ content: "Use the vote buttons for this regular poll.", flags: MessageFlags.Ephemeral });
    return;
  }

  const selectedOption = poll.options[optionIndex];
  if (!selectedOption) {
    await interaction.reply({ content: "That book is not part of this poll.", flags: MessageFlags.Ephemeral });
    return;
  }

  const currentVote = poll.votes?.[interaction.user.id];
  const rankedVote: RankedPollVote = isRankedPollVote(currentVote) ? { ...currentVote } : {};
  rankedVote[RANK_KEYS[rankIndex]] = optionIndex;

  await polls.updateOne(
    { pollId, guildId: interaction.guildId },
    {
      $set: {
        [`votes.${interaction.user.id}`]: rankedVote,
        updatedAt: new Date(),
      },
    },
  );

  const updatedPoll = await polls.findOne({ pollId, guildId: interaction.guildId });
  if (updatedPoll) {
    const duplicateWarning = hasDuplicateRankedChoices(rankedVote)
      ? " Pick three different books before the poll closes."
      : "";
    const completionText = isCompleteRankedVote(rankedVote, updatedPoll.options.length)
      ? " Your ranked ballot is complete."
      : " Choose your remaining ranked picks to complete your ballot.";
    const content = `Your #${rankIndex + 1} choice is **${formatBookTitle(
      selectedOption.title,
      selectedOption.author,
    )}**.${duplicateWarning || completionText}`;
    const privateBallot = {
      content,
      embeds: [buildPollEmbed(updatedPoll, page)],
      components: buildPollComponents(updatedPoll, false, page, interaction.user.id),
    };

    if (isEphemeralMessageInteraction(interaction)) {
      await interaction.update(privateBallot);
    } else {
      await interaction.reply({
        ...privateBallot,
        flags: MessageFlags.Ephemeral,
      });
    }

    await refreshPublicPollMessage(interaction, updatedPoll, page);
    return;
  }

  await interaction.reply({
    content: `Your #${rankIndex + 1} choice is **${formatBookTitle(selectedOption.title, selectedOption.author)}**.`,
    flags: MessageFlags.Ephemeral,
  });
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

  if (!poll || poll.status !== "active") {
    await interaction.reply({ content: "That poll is no longer active.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (getPollType(poll) === "ranked" && isEphemeralMessageInteraction(interaction)) {
    await interaction.update({
      content: "Your ranked ballot for this poll:",
      embeds: [buildPollEmbed(poll, page)],
      components: buildPollComponents(poll, false, page, interaction.user.id),
    });
    return;
  }

  await interaction.update({
    embeds: [buildPollEmbed(poll, page)],
    components: buildPollComponents(poll, false, page),
  });
}
