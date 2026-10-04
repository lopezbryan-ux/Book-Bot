import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildBookAddedEmbed } from "../book-embeds.js";
import { findBookByInput, formatBookTitle, getBookClubCollections, getImageUrlOrNull, normalizeTitle } from "../book-club.js";
import { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } from "../mongo.js";
import { invalidateRatingViewsCache } from "../rating-views.js";

export const data = new SlashCommandBuilder()
  .setName("update-book")
  .setDescription("Update an existing club book's title, author, or cover image.")
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("Choose the existing book to update.")
      .setAutocomplete(true)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("new-title")
      .setDescription("The new title. Omit to keep the current title.")
      .setMinLength(1)
      .setMaxLength(256),
  )
  .addStringOption((option) =>
    option
      .setName("author")
      .setDescription("The new author. Omit to keep the current author.")
      .setMinLength(1)
      .setMaxLength(200),
  )
  .addStringOption((option) =>
    option
      .setName("image-url")
      .setDescription("The new cover image URL. Omit to keep the current image.")
      .setMinLength(1)
      .setMaxLength(1000),
  );

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().trim();
  const { books } = getBookClubCollections();
  const availableBooks = await books
    .find({
      documentType: "book",
      guildId: interaction.guildId,
      ...(focusedValue
        ? {
            $or: [
              { title: { $regex: escapeRegex(focusedValue), $options: "i" } },
              { author: { $regex: escapeRegex(focusedValue), $options: "i" } },
            ],
          }
        : {}),
    })
    .collation({ locale: "en", strength: 2 })
    .sort({ title: 1 })
    .limit(25)
    .toArray();

  await interaction.respond(
    availableBooks.map((book) => ({
      name: formatBookTitle(book.title, book.author).slice(0, 100),
      value: book._id.toString(),
    })),
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const titleInput = interaction.options.getString("title", true).trim();
  const newTitleInput = interaction.options.getString("new-title")?.trim() ?? null;
  const authorInput = interaction.options.getString("author")?.trim() ?? null;
  const imageUrlInput = interaction.options.getString("image-url")?.trim() ?? null;
  const imageUrl = getImageUrlOrNull(imageUrlInput);

  let validationError: string | null = null;
  if (!titleInput) {
    validationError = "Choose a book from the club book list to update.";
  } else if (newTitleInput === null && authorInput === null && imageUrlInput === null) {
    validationError = "Provide at least one detail to update: `new-title`, `author`, or `image-url`.";
  } else if (newTitleInput === "" || authorInput === "" || imageUrlInput === "") {
    validationError = "The new title, author, and image URL cannot be blank. Omit a field to keep its current value.";
  } else if (imageUrlInput !== null && !imageUrl) {
    validationError = "That image URL does not look valid. Use a full `https://...` or `http://...` URL.";
  }

  if (validationError) {
    await interaction.reply({ content: validationError, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const { books } = getBookClubCollections();
  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection(BOOK_BOT_COLLECTION_NAME);
  const result = await mongoClient.withSession((session) =>
    session.withTransaction(async () => {
      const bookFilter = { documentType: "book" as const, guildId: interaction.guildId };
      const book = await findBookByInput(interaction.guildId, titleInput, session);

      if (!book) {
        return { error: "That book is not in the club book list." };
      }

      const title = newTitleInput ?? book.title;
      const normalizedTitle = newTitleInput === null ? book.normalizedTitle : normalizeTitle(newTitleInput);
      const titleChanged = title !== book.title || normalizedTitle !== book.normalizedTitle;
      const author = authorInput ?? book.author;
      const updatedImageUrl = imageUrlInput === null ? book.imageUrl : imageUrl;
      const authorChanged = author !== book.author;

      if (!titleChanged && !authorChanged && updatedImageUrl === book.imageUrl) {
        return { error: "Those details already match the book. There is nothing to update." };
      }

      if (titleChanged) {
        const duplicate = await books.findOne(
          { ...bookFilter, normalizedTitle, _id: { $ne: book._id } },
          { session },
        );
        if (duplicate) {
          return { error: "A club book with that title already exists. Choose a different title." };
        }
      }

      const updatedAt = new Date();
      await books.updateOne(
        { ...bookFilter, _id: book._id },
        { $set: { title, normalizedTitle, author, imageUrl: updatedImageUrl, updatedAt } },
        { session },
      );
      if (titleChanged || authorChanged) {
        // Preserve each member's score, review, and original rating timestamps.
        await ratings.updateMany(
          { documentType: "rating", guildId: interaction.guildId, bookId: book._id },
          {
            $set: {
              ...(titleChanged ? { bookTitle: title, normalizedTitle } : {}),
              ...(authorChanged ? { author } : {}),
            },
          },
          { session },
        );
      }

      return { book: { ...book, title, normalizedTitle, author, imageUrl: updatedImageUrl, updatedAt } };
    }),
  );

  if ("error" in result) {
    await interaction.editReply({ content: result.error });
    return;
  }

  invalidateRatingViewsCache(interaction.guildId);
  await interaction.editReply({
    embeds: [
      buildBookAddedEmbed({
        action: "Updated club book",
        title: result.book.title,
        author: result.book.author,
        imageUrl: result.book.imageUrl,
        note: result.book.note,
        footerText: `Updated by ${interaction.user.username}`,
      }),
    ],
  });
}
