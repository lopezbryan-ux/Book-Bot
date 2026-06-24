import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { getBookClubCollections, PollDocument, PollOption, formatBookTitle } from "./book-club.js";

const POLL_VOTE_PREFIX = "book-poll:vote";

export function buildPollCustomId(pollId: string, optionIndex: number) {
  return `${POLL_VOTE_PREFIX}:${pollId}:${optionIndex}`;
}

export function isBookPollVoteCustomId(customId: string) {
  return customId.startsWith(`${POLL_VOTE_PREFIX}:`);
}

export function buildPollEmbed(poll: Pick<PollDocument, "options" | "pollId" | "votes" | "status">) {
  const voteCounts = getVoteCounts(poll);
  const description = poll.options
    .map((option, index) => {
      const nomination = formatBookTitle(option.title, option.author);
      const cover = option.imageUrl ? ` ([cover](${option.imageUrl}))` : "";
      const votes = voteCounts[index] ?? 0;
      return `**${index + 1}.** ${nomination}${cover} - ${votes} vote${votes === 1 ? "" : "s"}`;
    })
    .join("\n");

  return new EmbedBuilder()
    .setTitle(poll.status === "active" ? "Book Club Poll" : "Closed Book Club Poll")
    .setDescription(description)
    .setFooter({ text: `Poll ID: ${poll.pollId}` });
}

export function buildPollComponents(poll: Pick<PollDocument, "options" | "pollId">, disabled = false) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let index = 0; index < poll.options.length; index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const options = poll.options.slice(index, index + 5);

    for (const [offset, option] of options.entries()) {
      const optionIndex = index + offset;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildPollCustomId(poll.pollId, optionIndex))
          .setLabel(`${optionIndex + 1}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
      );
    }

    rows.push(row);
  }

  return rows;
}

export function getVoteCounts(poll: Pick<PollDocument, "options" | "votes">) {
  const counts = Array.from({ length: poll.options.length }, () => 0);

  for (const optionIndex of Object.values(poll.votes ?? {})) {
    if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < counts.length) {
      counts[optionIndex] += 1;
    }
  }

  return counts;
}

export function getWinningOptions(poll: Pick<PollDocument, "options" | "votes">) {
  const counts = getVoteCounts(poll);
  const highestVoteCount = Math.max(...counts);

  if (highestVoteCount === 0) {
    return { counts, highestVoteCount, winners: [] as PollOption[] };
  }

  const winners = poll.options.filter((_, index) => counts[index] === highestVoteCount);
  return { counts, highestVoteCount, winners };
}

export async function handleBookPollVote(interaction: ButtonInteraction) {
  const [, , pollId, optionIndexText] = interaction.customId.split(":");
  const optionIndex = Number(optionIndexText);

  if (!pollId || !Number.isInteger(optionIndex)) {
    await interaction.reply({ content: "That poll vote button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { polls } = getBookClubCollections();
  const poll = await polls.findOne({ pollId, guildId: interaction.guildId });

  if (!poll || poll.status !== "active") {
    await interaction.reply({ content: "That poll is no longer active.", flags: MessageFlags.Ephemeral });
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
      embeds: [buildPollEmbed(updatedPoll)],
      components: buildPollComponents(updatedPoll),
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
