import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { ObjectId } from "mongodb";
import { buildBookAddedEmbed } from "../book-embeds.js";
import { formatBookTitle, getBookClubCollections, getImageUrlOrNull, normalizeTitle } from "../book-club.js";
import { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } from "../mongo.js";
import { invalidateRatingViewsCache } from "../rating-views.js";

export const data = new SlashCommandBuilder()
  .setName("update-book")
  .setDescription("Update an existing club book's author or cover image.")
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("Choose the existing book to update.")
      .setAutocomplete(true)
      .setRequired(true),
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
  const authorInput = interaction.options.getString("author")?.trim() ?? null;
  const imageUrlInput = interaction.options.getString("image-url")?.trim() ?? null;
  const imageUrl = getImageUrlOrNull(imageUrlInput);

  let validationError: string | null = null;
  if (!titleInput) {
    validationError = "Choose a book from the club book list to update.";
  } else if (authorInput === null && imageUrlInput === null) {
    validationError = "Provide at least one detail to update: `author` or `image-url`.";
  } else if (authorInput === "" || imageUrlInput === "") {
    validationError = "The author and image URL cannot be blank. Omit a field to keep its current value.";
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
      // Autocomplete uses the stable book ID; a manually entered title works too.
      const selectedBook = ObjectId.isValid(titleInput)
        ? await books.findOne({ ...bookFilter, _id: new ObjectId(titleInput) }, { session })
        : null;
      const book = selectedBook ??
        await books.findOne({ ...bookFilter, normalizedTitle: normalizeTitle(titleInput) }, { session });

      if (!book) {
        return { error: "That book is not in the club book list." };
      }

      const author = authorInput ?? book.author;
      const updatedImageUrl = imageUrlInput === null ? book.imageUrl : imageUrl;
      const authorChanged = author !== book.author;

      if (!authorChanged && updatedImageUrl === book.imageUrl) {
        return { error: "Those details already match the book. There is nothing to update." };
      }

      const updatedAt = new Date();
      await books.updateOne(
        { ...bookFilter, _id: book._id },
        { $set: { author, imageUrl: updatedImageUrl, updatedAt } },
        { session },
      );
      if (authorChanged) {
        // Preserve each member's score, review, and original rating timestamps.
        await ratings.updateMany(
          { documentType: "rating", guildId: interaction.guildId, normalizedTitle: book.normalizedTitle },
          { $set: { author } },
          { session },
        );
      }

      return { book: { ...book, author, imageUrl: updatedImageUrl, updatedAt } };
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
