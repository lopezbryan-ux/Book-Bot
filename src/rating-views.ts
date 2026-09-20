import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { ObjectId } from "mongodb";
import { getBookClubCollections } from "./book-club.js";
import { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } from "./mongo.js";

const RATING_LIST_PREFIX = "rating-list";
const BOOK_LEADERBOARD_PREFIX = "book-leaderboard";
const BOOK_REVIEWS_PREFIX = "book-reviews";
const RATINGS_PER_PAGE = 1;
const LEADERBOARD_BOOKS_PER_PAGE = 5;
const BOOK_REVIEWS_PER_PAGE = 3;

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

interface BookLeaderboardEntry {
  _id: string;
  bookTitle: string;
  author: string | null;
  averageRating: number;
  ratingCount: number;
  ratingSpread: number;
}

interface BookLeaderboardDisplayEntry extends BookLeaderboardEntry {
  title: string;
  displayAuthor: string;
}

interface CachedBookLeaderboard {
  expiresAt: number;
  entriesPromise: Promise<BookLeaderboardDisplayEntry[]>;
}

export type BookLeaderboardRanking = "highest-rated" | "most-rated" | "most-divisive";

const BOOK_LEADERBOARD_CACHE_TTL_MS = 60_000;
const bookLeaderboardCache = new Map<
  string | null,
  Map<BookLeaderboardRanking, CachedBookLeaderboard>
>();

const bookLeaderboardRankings: Record<
  BookLeaderboardRanking,
  {
    title: string;
    description: string;
    sort: Record<string, 1 | -1>;
  }
> = {
  "highest-rated": {
    title: "Highest Rated Books",
    description: "Ranked by the club's average rating.",
    sort: { averageRating: -1, ratingCount: -1, bookTitle: 1 },
  },
  "most-rated": {
    title: "Most Rated Books",
    description: "Ranked by how many club members submitted a rating.",
    sort: { ratingCount: -1, averageRating: -1, bookTitle: 1 },
  },
  "most-divisive": {
    title: "Most Divisive Books",
    description: "Ranked by rating spread. Books need at least two ratings.",
    sort: { ratingSpread: -1, ratingCount: -1, bookTitle: 1 },
  },
};

function buildRatingListCustomId(userId: string, page: number) {
  return `${RATING_LIST_PREFIX}:${userId}:${page}`;
}

function buildBookLeaderboardCustomId(ranking: BookLeaderboardRanking, page: number) {
  return `${BOOK_LEADERBOARD_PREFIX}:${ranking}:${page}`;
}

function buildBookReviewsCustomId(bookId: string, page: number) {
  return `${BOOK_REVIEWS_PREFIX}:${bookId}:${page}`;
}

function formatRating(ratingValue: unknown) {
  const rating = typeof ratingValue === "number" ? ratingValue : Number(ratingValue);
  const roundedRating = Math.round(rating * 10) / 10;
  return {
    value: `${roundedRating.toFixed(1)}/10`,
    number: roundedRating,
  };
}

function truncateReview(review: string) {
  return review.length > 220 ? `${review.slice(0, 217)}...` : review;
}

function truncateEmbedValue(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3).trimEnd()}...` : value;
}

function truncateEmbedFieldName(value: string) {
  return truncateEmbedValue(value, 256);
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

export function isBookLeaderboardPageCustomId(customId: string) {
  return customId.startsWith(`${BOOK_LEADERBOARD_PREFIX}:`);
}

export function isBookLeaderboardRanking(value: string): value is BookLeaderboardRanking {
  return value in bookLeaderboardRankings;
}

export function invalidateBookLeaderboardCache(guildId: string | null) {
  bookLeaderboardCache.delete(guildId);
}

export function isBookReviewsPageCustomId(customId: string) {
  return customId.startsWith(`${BOOK_REVIEWS_PREFIX}:`);
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
    embed.setImage(firstCover);
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
    const updated = `\nUpdated ${formatDate(rating.updatedAt)}`;
    embed.addFields({
      name: "Rating",
      value: `Your rating: **${ratingDisplay.value}**${averageText}${review}${updated}`,
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

async function loadBookLeaderboardEntries(
  guildId: string | null,
  ranking: BookLeaderboardRanking,
): Promise<BookLeaderboardDisplayEntry[]> {
  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection<RatingDocument>(BOOK_BOT_COLLECTION_NAME);
  const rankingOption = bookLeaderboardRankings[ranking];
  const minimumRatingStages = ranking === "most-divisive" ? [{ $match: { ratingCount: { $gte: 2 } } }] : [];
  const leaderboardEntries = await ratings
    .aggregate<BookLeaderboardEntry>([
      {
        $match: {
          documentType: "rating",
          guildId,
        },
      },
      {
        $sort: {
          updatedAt: -1,
        },
      },
      {
        $group: {
          _id: "$normalizedTitle",
          bookTitle: { $first: "$bookTitle" },
          author: { $first: "$author" },
          averageRating: { $avg: "$rating" },
          ratingCount: { $sum: 1 },
          ratingSpread: { $stdDevPop: "$rating" },
        },
      },
      ...minimumRatingStages,
      {
        $sort: rankingOption.sort,
      },
      {
        $project: {
          bookTitle: 1,
          author: 1,
          averageRating: 1,
          ratingCount: 1,
          ratingSpread: 1,
        },
      },
    ])
    .toArray();

  const { books } = getBookClubCollections();
  const bookDocs = await books
    .find({
      documentType: "book",
      guildId,
      normalizedTitle: { $in: leaderboardEntries.map((entry) => entry._id) },
    })
    .toArray();
  const booksByTitle = new Map(bookDocs.map((book) => [book.normalizedTitle, book]));

  return leaderboardEntries.map((entry) => {
    const book = booksByTitle.get(entry._id);
    return {
      ...entry,
      title: book?.title ?? entry.bookTitle,
      displayAuthor: book?.author ?? entry.author ?? "Unknown author",
    };
  });
}

async function getBookLeaderboardEntries(guildId: string | null, ranking: BookLeaderboardRanking) {
  const now = Date.now();
  let guildCache = bookLeaderboardCache.get(guildId);
  const cachedLeaderboard = guildCache?.get(ranking);

  if (cachedLeaderboard && cachedLeaderboard.expiresAt > now) {
    return cachedLeaderboard.entriesPromise;
  }

  if (!guildCache) {
    guildCache = new Map();
    bookLeaderboardCache.set(guildId, guildCache);
  }

  const entriesPromise = loadBookLeaderboardEntries(guildId, ranking);
  const cacheEntry: CachedBookLeaderboard = {
    expiresAt: now + BOOK_LEADERBOARD_CACHE_TTL_MS,
    entriesPromise,
  };
  guildCache.set(ranking, cacheEntry);

  try {
    return await entriesPromise;
  } catch (error) {
    if (guildCache.get(ranking) === cacheEntry) {
      guildCache.delete(ranking);
    }
    throw error;
  }
}

export async function buildBookLeaderboardMessage(
  guildId: string | null,
  page: number,
  ranking: BookLeaderboardRanking = "highest-rated",
) {
  const rankingOption = bookLeaderboardRankings[ranking];
  const allLeaderboardEntries = await getBookLeaderboardEntries(guildId, ranking);
  const totalBooks = allLeaderboardEntries.length;
  const totalPages = Math.max(1, Math.ceil(totalBooks / LEADERBOARD_BOOKS_PER_PAGE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const leaderboardEntries = allLeaderboardEntries.slice(
    safePage * LEADERBOARD_BOOKS_PER_PAGE,
    (safePage + 1) * LEADERBOARD_BOOKS_PER_PAGE,
  );
  const embed = new EmbedBuilder()
    .setColor(0x6f8f72)
    .setTitle(rankingOption.title)
    .setDescription(rankingOption.description)
    .setFooter({ text: `Page ${safePage + 1} of ${totalPages}` })
    .setTimestamp();

  for (const [index, entry] of leaderboardEntries.entries()) {
    const rank = safePage * LEADERBOARD_BOOKS_PER_PAGE + index + 1;
    const ratingCountLabel = `${entry.ratingCount} rating${entry.ratingCount === 1 ? "" : "s"}`;
    const ratingSummary = `Average Rating: **${entry.averageRating.toFixed(1)}/10** from ${ratingCountLabel}`;
    const fieldLines =
      ranking === "most-divisive"
        ? [
            `Author: ${entry.displayAuthor}`,
            `Rating Spread: **${entry.ratingSpread.toFixed(2)}** standard deviation`,
            ratingSummary,
          ]
        : [`Author: ${entry.displayAuthor}`, ratingSummary];

    embed.addFields({
      name: truncateEmbedFieldName(`${rank}. ${entry.title}`),
      value: truncateEmbedValue(fieldLines.join("\n"), 1024),
    });
  }

  const components =
    totalPages > 1
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildBookLeaderboardCustomId(ranking, safePage - 1))
              .setLabel("Prev")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage === 0),
            new ButtonBuilder()
              .setCustomId(buildBookLeaderboardCustomId(ranking, safePage))
              .setLabel(`${safePage + 1}/${totalPages}`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(buildBookLeaderboardCustomId(ranking, safePage + 1))
              .setLabel("Next")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage >= totalPages - 1),
          ),
        ]
      : [];

  return { embeds: [embed], components, totalBooks };
}

export async function buildBookReviewsMessage(guildId: string | null, bookId: string, page: number) {
  if (!ObjectId.isValid(bookId)) {
    return { embeds: [], components: [], totalRatings: 0, book: null };
  }

  const { books } = getBookClubCollections();
  const book = await books.findOne({
    _id: new ObjectId(bookId),
    documentType: "book",
    guildId,
  });

  if (!book) {
    return { embeds: [], components: [], totalRatings: 0, book: null };
  }

  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection<RatingDocument>(BOOK_BOT_COLLECTION_NAME);
  const ratingsQuery = {
    documentType: "rating" as const,
    guildId,
    normalizedTitle: book.normalizedTitle,
  };
  const totalRatings = await ratings.countDocuments(ratingsQuery);
  const totalPages = Math.max(1, Math.ceil(totalRatings / BOOK_REVIEWS_PER_PAGE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageRatings = await ratings
    .find(ratingsQuery)
    .sort({ updatedAt: -1 })
    .skip(safePage * BOOK_REVIEWS_PER_PAGE)
    .limit(BOOK_REVIEWS_PER_PAGE)
    .toArray();

  const ratingSummary = await getBookRatingSummary(guildId, book.normalizedTitle);
  const ratingSummaryText =
    ratingSummary.ratingCount > 0
      ? `Club average: **${ratingSummary.averageRating.toFixed(1)}/10** from ${ratingSummary.ratingCount} rating${
          ratingSummary.ratingCount === 1 ? "" : "s"
        }`
      : "No ratings yet.";

  const embed = new EmbedBuilder()
    .setColor(0xd9a441)
    .setTitle(book.title)
    .setDescription(`${book.author ? `by **${book.author}**\n` : ""}${ratingSummaryText}`)
    .setFooter({ text: `Ratings and reviews page ${safePage + 1} of ${totalPages}` })
    .setTimestamp();

  if (book.imageUrl) {
    embed.setThumbnail(book.imageUrl);
  }

  for (const review of pageRatings) {
    const ratingDisplay = formatRating(review.rating);
    const reviewer = review.username?.trim() || "Unknown reviewer";
    const writtenReview = review.review?.trim();
    const reviewText = writtenReview
      ? truncateEmbedValue(writtenReview, 900)
      : "*No written review provided.*";
    embed.addFields({
      name: truncateEmbedFieldName(`${reviewer} - ${ratingDisplay.value}`),
      value: truncateEmbedValue(`> ${reviewText}\nUpdated ${formatDate(review.updatedAt)}`, 1024),
    });
  }

  const components =
    totalPages > 1
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildBookReviewsCustomId(bookId, safePage - 1))
              .setLabel("Prev")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage === 0),
            new ButtonBuilder()
              .setCustomId(buildBookReviewsCustomId(bookId, safePage))
              .setLabel(`${safePage + 1}/${totalPages}`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(buildBookReviewsCustomId(bookId, safePage + 1))
              .setLabel("Next")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage >= totalPages - 1),
          ),
        ]
      : [];

  return { embeds: [embed], components, totalRatings, book };
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

export async function handleBookLeaderboardPage(interaction: ButtonInteraction) {
  const [, rankingOrPage, currentPage] = interaction.customId.split(":");
  const ranking = rankingOrPage && isBookLeaderboardRanking(rankingOrPage) ? rankingOrPage : "highest-rated";
  const pageText = currentPage ?? rankingOrPage;
  const page = Number(pageText);

  if (!Number.isInteger(page)) {
    await interaction.reply({ content: "That leaderboard page button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const message = await buildBookLeaderboardMessage(interaction.guildId, page, ranking);
  await interaction.editReply({
    embeds: message.embeds,
    components: message.components,
  });
}

export async function handleBookReviewsPage(interaction: ButtonInteraction) {
  const [, bookId, pageText] = interaction.customId.split(":");
  const page = Number(pageText);

  if (!bookId || !Number.isInteger(page)) {
    await interaction.reply({ content: "That review page button is invalid.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const message = await buildBookReviewsMessage(interaction.guildId, bookId, page);
  if (!message.book) {
    await interaction.editReply({
      content: "That book could not be found anymore.",
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.editReply({
    embeds: message.embeds,
    components: message.components,
  });
}
