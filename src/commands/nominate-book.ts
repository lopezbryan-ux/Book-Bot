import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import {
  NominationDocument,
  PollDocument,
  PollOption,
  PollVotes,
  RankedPollVote,
  formatBookTitle,
  getBookClubCollections,
  getImageUrlOrNull,
  normalizeTitle,
} from "../book-club.js";
import { buildPollComponents, buildPollEmbed } from "../polls.js";

export const data = new SlashCommandBuilder()
  .setName("nominate-book")
  .setDescription("Nominate a book for the next club poll.")
  .addStringOption((option) =>
    option.setName("title").setDescription("The title of the book you want to nominate.").setRequired(true),
  )
  .addStringOption((option) =>
    option.setName("author").setDescription("The book author.").setMaxLength(200).setRequired(true),
  )
  .addStringOption((option) =>
    option.setName("reason").setDescription("Why you think the club should read it.").setMaxLength(1000),
  )
  .addStringOption((option) =>
    option.setName("image-url").setDescription("Optional book cover image URL.").setMaxLength(1000),
  );

function buildPollOption(nomination: NominationDocument): PollOption {
  return {
    nominationId: nomination.nominationId,
    title: nomination.title,
    normalizedTitle: nomination.normalizedTitle,
    author: nomination.author,
    nominatedBy: nomination.nominatedBy,
    reason: nomination.reason,
    imageUrl: nomination.imageUrl,
  };
}

function isRankedPollVote(value: unknown): value is RankedPollVote {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapRegularVote(vote: number, indexMap: Map<number, number>) {
  return indexMap.get(vote);
}

function remapRankedVote(vote: RankedPollVote, indexMap: Map<number, number>) {
  const remappedVote: RankedPollVote = {};

  for (const rankKey of ["first", "second", "third"] as const) {
    const choice = vote[rankKey];
    if (typeof choice !== "number") continue;

    const remappedChoice = indexMap.get(choice);
    if (typeof remappedChoice === "number") {
      remappedVote[rankKey] = remappedChoice;
    }
  }

  return remappedVote;
}

function remapPollVotes(votes: PollVotes, indexMap: Map<number, number>) {
  const remappedVotes: PollVotes = {};

  for (const [userId, vote] of Object.entries(votes ?? {})) {
    if (typeof vote === "number") {
      const remappedVote = remapRegularVote(vote, indexMap);
      if (typeof remappedVote === "number") {
        remappedVotes[userId] = remappedVote;
      }
      continue;
    }

    if (isRankedPollVote(vote)) {
      remappedVotes[userId] = remapRankedVote(vote, indexMap);
    }
  }

  return remappedVotes;
}

async function refreshPollMessage(interaction: ChatInputCommandInteraction, poll: PollDocument) {
  if (!poll.messageId) return;

  const channel =
    poll.channelId === interaction.channelId
      ? interaction.channel
      : await interaction.client.channels.fetch(poll.channelId).catch(() => null);

  if (!channel?.isTextBased()) return;

  const pollMessage = await channel.messages.fetch(poll.messageId).catch(() => null);
  await pollMessage?.edit({
    embeds: [buildPollEmbed(poll)],
    components: buildPollComponents(poll),
  });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString("title", true).trim();
  const author = interaction.options.getString("author")?.trim() || null;
  const reason = interaction.options.getString("reason")?.trim() || null;
  const imageUrlInput = interaction.options.getString("image-url")?.trim() || null;
  const imageUrl = getImageUrlOrNull(imageUrlInput);

  if (!title) {
    await interaction.reply({ content: "Give me a book title to nominate.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (imageUrlInput && !imageUrl) {
    await interaction.reply({
      content: "That image URL does not look valid. Use a full `https://...` or `http://...` URL.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { nominations, polls } = getBookClubCollections();
  const now = new Date();
  const normalizedTitle = normalizeTitle(title);
  const existingNomination = await nominations.findOne({
    documentType: "nomination",
    guildId: interaction.guildId,
    nominatedBy: interaction.user.id,
    status: "nominated",
  });
  const nominationId = existingNomination?.nominationId ?? randomUUID();

  const result = await nominations.updateOne(
    {
      documentType: "nomination",
      guildId: interaction.guildId,
      nominatedBy: interaction.user.id,
      status: "nominated",
    },
    {
      $set: {
        title,
        normalizedTitle,
        author,
        reason,
        imageUrl,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        nominatedBy: interaction.user.id,
        nominatedByUsername: interaction.user.username,
        updatedAt: now,
      },
      $setOnInsert: {
        nominationId,
        documentType: "nomination",
        status: "nominated",
        createdAt: now,
      },
    },
    { upsert: true },
  );

  await nominations.deleteMany({
    documentType: "nomination",
    guildId: interaction.guildId,
    nominatedBy: interaction.user.id,
    status: "nominated",
    nominationId: { $ne: nominationId },
  });

  const nomination = await nominations.findOne({
    documentType: "nomination",
    guildId: interaction.guildId,
    nominationId,
    status: "nominated",
  });

  const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" });
  let pollText = "";

  if (nomination && activePoll) {
    const pollOption = buildPollOption(nomination);
    const optionIndex = activePoll.options.findIndex(
      (option) => option.nominationId === nomination.nominationId || option.nominatedBy === interaction.user.id,
    );

    if (optionIndex >= 0) {
      const dedupedOptions: PollOption[] = [];
      const indexMap = new Map<number, number>();

      activePoll.options.forEach((option, index) => {
        const belongsToCurrentNomination = option.nominationId === nomination.nominationId || option.nominatedBy === interaction.user.id;
        if (belongsToCurrentNomination && index !== optionIndex) return;

        indexMap.set(index, dedupedOptions.length);
        dedupedOptions.push(index === optionIndex ? pollOption : option);
      });

      await polls.updateOne(
        { pollId: activePoll.pollId, guildId: interaction.guildId },
        {
          $set: {
            options: dedupedOptions,
            votes: remapPollVotes(activePoll.votes, indexMap),
            updatedAt: now,
          },
        },
      );
      pollText = "\nReplaced your book in the active poll.";
    } else {
      await polls.updateOne(
        { pollId: activePoll.pollId, guildId: interaction.guildId },
        {
          $push: {
            options: pollOption,
          },
          $set: {
            updatedAt: now,
          },
        },
      );
      pollText = "\nAdded this book to the active poll.";
    }

    const updatedPoll = await polls.findOne({ pollId: activePoll.pollId, guildId: interaction.guildId });
    if (updatedPoll) {
      await refreshPollMessage(interaction, updatedPoll);
    }
  }

  const action =
    result.upsertedCount > 0
      ? "Nominated"
      : existingNomination
        ? "Replaced your nomination with"
        : "Updated your nomination for";
  const imageText = imageUrl ? `\nCover: ${imageUrl}` : "";
  await interaction.reply(`${action} **${formatBookTitle(title, author)}**.${imageText}${pollText}`);
}
