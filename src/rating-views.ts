import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { getBookClubCollections } from "./book-club.js";
import { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } from "./mongo.js";

const RATING_LIST_PREFIX = "rating-list";
const RATINGS_PER_PAGE = 1;

interface RatingDocument {
  documentType: "rating";
  guildId: string | null;
  userId: string;
  username: string;
  normalizedTitle: string;
  bookTitle: string;
  author: string | null;
  rating: number;
  review: string | null;
  updatedAt: Date;
}

function buildRatingListCustomId(userId: string, page: number) {
  return `${RATING_LIST_PREFIX}:${userId}:${page}`;
}

function formatRating(ratingValue: unknown) {
  const rating = typeof ratingValue === "number" ? ratingValue : Number(ratingValue);
  const roundedRating = Math.round(rating * 10) / 10;
  const filledBlocks = Math.round(roundedRating);
  return {
    bar: `${"#".repeat(filledBlocks)}${"-".repeat(10 - filledBlocks)}`,
    value: `${roundedRating.toFixed(1)}/10`,
    number: roundedRating,
  };
}

function truncateReview(review: string) {
  return review.length > 220 ? `${review.slice(0, 217)}...` : review;
}

function formatDate(value: Date | string | undefined) {
  if (!value) return "Unknown date";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function isRatingListPageCustomId(customId: string) {
  return customId.startsWith(`${RATING_LIST_PREFIX}:`);
}

export async function getBookRatingSummary(guildId: string | null, normalizedTitle: string) {
  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection<RatingDocument>(BOOK_BOT_COLLECTION_NAME);
  const result = await ratings
    .aggregate<{ averageRating: number; ratingCount: number }>([
      {
        $match: {
          documentType: "rating",
          guildId,
          normalizedTitle,
        },
      },
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$rating" },
          ratingCount: { $sum: 1 },
        },
      },
    ])
    .toArray();

  return {
    averageRating: result[0]?.averageRating ?? 0,
    ratingCount: result[0]?.ratingCount ?? 0,
  };
}

export async function buildRatingListMessage(guildId: string | null, userId: string, userLabel: string, page: number) {
  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection<RatingDocument>(BOOK_BOT_COLLECTION_NAME);
  const totalRatings = await ratings.countDocuments({
    documentType: "rating",
    guildId,
    userId,
  });
  const bookAverageResults = await ratings
    .aggregate<{ _id: string; averageRating: number; ratingCount: number }>([
      {
        $match: {
          documentType: "rating",
          guildId,
        },
      },
      {
        $group: {
          _id: "$normalizedTitle",
          averageRating: { $avg: "$rating" },
          ratingCount: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const bookAveragesByTitle = new Map(
    bookAverageResults.map((result) => [
      result._id,
      {
        averageRating: result.averageRating,
        ratingCount: result.ratingCount,
      },
    ]),
  );
  const totalPages = Math.max(1, Math.ceil(totalRatings / RATINGS_PER_PAGE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageRatings = await ratings
    .find({
      documentType: "rating",
      guildId,
      userId,
    })
    .sort({ updatedAt: -1 })
    .skip(safePage * RATINGS_PER_PAGE)
    .limit(RATINGS_PER_PAGE)
    .toArray();

  const { books } = getBookClubCollections();
  const bookDocs = await books
    .find({
      documentType: "book",
      guildId,
      normalizedTitle: { $in: pageRatings.map((rating) => rating.normalizedTitle) },
    })
    .toArray();
  const booksByTitle = new Map(bookDocs.map((book) => [book.normalizedTitle, book]));

  const currentRating = pageRatings[0];
  const currentBook = currentRating ? booksByTitle.get(currentRating.normalizedTitle) : null;
  const currentTitle = currentRating ? currentBook?.title ?? currentRating.bookTitle : "Reading Ratings";
  const currentAuthor = currentRating ? currentBook?.author ?? currentRating.author : null;

  const embed = new EmbedBuilder()
    .setColor(0xd9a441)
    .setTitle(currentTitle)
    .setDescription(`${currentAuthor ? `by **${currentAuthor}**\n` : ""}${userLabel}'s rating`)
    .setFooter({ text: `Rating ${safePage + 1} of ${totalRatings}` })
    .setTimestamp();

  const firstCover = pageRatings.map((rating) => booksByTitle.get(rating.normalizedTitle)?.imageUrl).find(Boolean);
  if (firstCover) {
    embed.setThumbnail(firstCover);
  }

  for (const rating of pageRatings) {
    const book = booksByTitle.get(rating.normalizedTitle);
    const ratingDisplay = formatRating(rating.rating);
    const bookAverage = bookAveragesByTitle.get(rating.normalizedTitle);
    const averageText = bookAverage
      ? `\nClub average: **${bookAverage.averageRating.toFixed(1)}/10** from ${bookAverage.ratingCount} rating${
          bookAverage.ratingCount === 1 ? "" : "s"
        }`
      : "";
    const review = rating.review ? `\n> ${truncateReview(rating.review)}` : "";
    const cover = book?.imageUrl ? `\n[Cover](${book.imageUrl})` : "";
    const updated = `\nUpdated ${formatDate(rating.updatedAt)}`;
    embed.addFields({
      name: "Rating",
      value: `Your rating: \`${ratingDisplay.bar}\` **${ratingDisplay.value}**${averageText}${review}${cover}${updated}`,
    });
  }

  const components =
    totalPages > 1
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildRatingListCustomId(userId, safePage - 1))
              .setLabel("Prev")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage === 0),
            new ButtonBuilder()
              .setCustomId(buildRatingListCustomId(userId, safePage))
              .setLabel(`${safePage + 1}/${totalPages}`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(buildRatingListCustomId(userId, safePage + 1))
              .setLabel("Next")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage >= totalPages - 1),
          ),
        ]
      : [];

  return { embeds: [embed], components, totalRatings };
}

export async function handleRatingListPage(interaction: ButtonInteraction) {
  const [, userId, pageText] = interaction.customId.split(":");
  const page = Number(pageText);

  if (!userId || !Number.isInteger(page)) {
    await interaction.reply({ content: "That ratings page button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  const message = await buildRatingListMessage(interaction.guildId, userId, `<@${userId}>`, page);
  await interaction.update({
    embeds: message.embeds,
    components: message.components,
  });
}
