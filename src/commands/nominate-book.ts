import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { randomUUID } from "node:crypto";
import {
  NominationDocument,
  PollOption,
  formatBookTitle,
  getBookClubCollections,
  getImageUrlOrNull,
  normalizeTitle,
} from "../book-club.js";
import { remapPollVotes } from "../poll-votes.js";
import { refreshPollMessage } from "../polls.js";
import { mongoClient } from "../mongo.js";
import { isPollOpen, openPollFilter, PollClosedError } from "../poll-state.js";

export const data = new SlashCommandBuilder()
  .setName("nominate-book")
  .setDescription("Nominate a book for the active club poll.")
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

export async function execute(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString("title", true).trim();
  const author = interaction.options.getString("author")?.trim() || null;
  const reason = interaction.options.getString("reason")?.trim() || null;
  const imageUrlInput = interaction.options.getString("image-url")?.trim() || null;
  const imageUrl = getImageUrlOrNull(imageUrlInput);

  if (!title || (imageUrlInput && !imageUrl)) {
    await interaction.reply({
      content: !title ? "Give me a book title to nominate." : "That image URL does not look valid. Use a full `https://...` or `http://...` URL.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const { nominations, polls } = getBookClubCollections();
  const result = await mongoClient.withSession((session) => session.withTransaction(async () => {
    const activePoll = await polls.findOne({ guildId: interaction.guildId, status: "active" }, { session });
    if (!activePoll || !isPollOpen(activePoll)) {
      return { error: "There is no open book poll right now. Start one with `/start-book-poll` before nominating books." };
    }

    const now = new Date();
    const normalizedTitle = normalizeTitle(title);
    const canNominateMultiple = activePoll.createdBy === interaction.user.id;
    const nominationLookup = {
      documentType: "nomination" as const,
      guildId: interaction.guildId,
      nominatedBy: interaction.user.id,
      status: "nominated" as const,
      ...(canNominateMultiple ? { normalizedTitle } : {}),
    };
    const existingNomination = await nominations.findOne(nominationLookup, { session });
    const replacedBook = !!existingNomination && (
      existingNomination.normalizedTitle !== normalizedTitle ||
      normalizeTitle(existingNomination.author ?? "") !== normalizeTitle(author ?? "")
    );
    // A different book gets a different ID; votes must not transfer to its replacement.
    const nominationId = !replacedBook && existingNomination ? existingNomination.nominationId : randomUUID();
    const nominationUpdate = await nominations.updateOne(nominationLookup, {
      $set: {
        nominationId, title, normalizedTitle, author, reason, imageUrl,
        guildId: interaction.guildId, channelId: interaction.channelId,
        nominatedBy: interaction.user.id, nominatedByUsername: interaction.user.username, updatedAt: now,
      },
      $setOnInsert: { documentType: "nomination", status: "nominated", createdAt: now },
    }, { upsert: true, session });

    if (!canNominateMultiple) {
      await nominations.deleteMany({
        documentType: "nomination", guildId: interaction.guildId, nominatedBy: interaction.user.id,
        status: "nominated", nominationId: { $ne: nominationId },
      }, { session });
    }
    const nomination = await nominations.findOne({ nominationId, guildId: interaction.guildId }, { session });
    if (!nomination) throw new Error("The saved nomination could not be found.");

    const pollOption = buildPollOption(nomination);
    const belongsToNomination = (option: PollOption) =>
      option.nominationId === nominationId ||
      option.nominationId === existingNomination?.nominationId ||
      (!canNominateMultiple && option.nominatedBy === interaction.user.id);
    const optionIndex = activePoll.options.findIndex(belongsToNomination);
    const options: PollOption[] = [];
    const indexMap = new Map<number, number>();
    activePoll.options.forEach((option, index) => {
      if (belongsToNomination(option) && index !== optionIndex) return;
      // Preserve votes only when the nomination still represents the same book.
      if (index !== optionIndex || option.nominationId === nominationId) indexMap.set(index, options.length);
      options.push(index === optionIndex ? pollOption : option);
    });
    if (optionIndex < 0) options.push(pollOption);
    const votes = remapPollVotes(activePoll.votes, indexMap);
    const update = await polls.updateOne(openPollFilter(activePoll.pollId, interaction.guildId), {
      $set: { options, votes, updatedAt: now },
    }, { session });
    if (update.matchedCount === 0) throw new PollClosedError();

    return {
      poll: { ...activePoll, options, votes, updatedAt: now },
      action: nominationUpdate.upsertedCount > 0 ? "Nominated" : canNominateMultiple ? "Updated your nomination for" : "Replaced your nomination with",
      pollText: optionIndex < 0 ? "Added this book to the active poll." : replacedBook ? "Votes for the previous book were cleared. Members can vote again." : "Updated this book in the active poll.",
    };
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } })).catch((error: unknown) => {
    if (error instanceof PollClosedError) return { error: error.message };
    throw error;
  });

  if ("error" in result) {
    await interaction.editReply({ content: result.error });
    return;
  }
  await refreshPollMessage(interaction.client, result.poll);
  const imageText = imageUrl ? `\nCover: ${imageUrl}` : "";
  await interaction.editReply(`${result.action} **${formatBookTitle(title, author)}**.${imageText}\n${result.pollText}`);
}
