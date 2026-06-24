import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { buildBookRatingEmbed } from "../book-embeds.js";
import { formatBookTitle, getBookClubCollections, normalizeTitle } from "../book-club.js";
import { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } from "../mongo.js";
import { buildRatingListMessage, getBookRatingSummary } from "../rating-views.js";

export const data = new SlashCommandBuilder()
  .setName("view-rating")
  .setDescription("View your rating or another member's rating for a club book.")
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("Choose a book from the club book list.")
      .setAutocomplete(true),
  )
  .addUserOption((option) => option.setName("user").setDescription("Whose rating to view. Defaults to you."));

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateChoiceValue(value: string) {
  return value.length > 100 ? value.slice(0, 100) : value;
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().trim();
  const { books } = getBookClubCollections();
  const query = focusedValue
    ? {
        documentType: "book" as const,
        guildId: interaction.guildId,
        $or: [
          { title: { $regex: escapeRegex(focusedValue), $options: "i" } },
          { author: { $regex: escapeRegex(focusedValue), $options: "i" } },
        ],
      }
    : {
        documentType: "book" as const,
        guildId: interaction.guildId,
      };

  const availableBooks = await books.find(query).collation({ locale: "en", strength: 2 }).sort({ title: 1 }).limit(25).toArray();

  await interaction.respond(
    availableBooks.map((book) => ({
      name: truncateChoiceValue(formatBookTitle(book.title, book.author)),
      value: truncateChoiceValue(book.normalizedTitle),
    })),
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const titleInput = interaction.options.getString("title")?.trim() ?? null;
  const targetUser = interaction.options.getUser("user") ?? interaction.user;

  if (!titleInput) {
    const message = await buildRatingListMessage(interaction.guildId, targetUser.id, targetUser.toString(), 0);

    if (message.totalRatings === 0) {
      await interaction.reply({
        content:
          targetUser.id === interaction.user.id
            ? "You have not rated any books yet."
            : `${targetUser} has not rated any books yet.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: message.embeds,
      components: message.components,
    });
    return;
  }

  const { books } = getBookClubCollections();
  const normalizedTitle = normalizeTitle(titleInput);
  const book = await books.findOne({
    documentType: "book",
    guildId: interaction.guildId,
    normalizedTitle,
  });

  if (!book) {
    await interaction.reply({
      content: "That book is not in the club book list yet.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection(BOOK_BOT_COLLECTION_NAME);
  const rating = await ratings.findOne({
    documentType: "rating",
    guildId: interaction.guildId,
    userId: targetUser.id,
    normalizedTitle: book.normalizedTitle,
  });

  if (!rating) {
    await interaction.reply({
      content: `${targetUser} has not rated **${formatBookTitle(book.title, book.author)}** yet.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ratingSummary = await getBookRatingSummary(interaction.guildId, book.normalizedTitle);

  await interaction.reply({
    embeds: [
      buildBookRatingEmbed({
        heading: "Book Rating",
        title: book.title,
        author: book.author,
        imageUrl: book.imageUrl,
        rating: typeof rating.rating === "number" ? rating.rating : Number(rating.rating),
        averageRating: ratingSummary.averageRating,
        ratingCount: ratingSummary.ratingCount,
        review: typeof rating.review === "string" ? rating.review : null,
        ratedBy: targetUser,
      }),
    ],
  });
}
