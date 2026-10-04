import { ObjectId } from "mongodb";
import { BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME, mongoClient } from "./mongo.js";

export interface RatingDocument {
  documentType: "rating";
  guildId: string | null;
  bookId: ObjectId;
  userId: string;
  username: string;
  normalizedTitle: string;
  bookTitle: string;
  author: string | null;
  rating: number;
  review: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function ensureRatingBookIdIndex() {
  const ratings = mongoClient.db(BOOK_BOT_DB_NAME).collection<RatingDocument>(BOOK_BOT_COLLECTION_NAME);
  const legacyCount = await ratings.countDocuments({
    documentType: "rating",
    bookId: { $not: { $type: "objectId" } },
  });
  if (legacyCount > 0) {
    throw new Error(`${legacyCount} ratings need book IDs. Run the rating migration before starting the bot.`);
  }
  await ratings.createIndex(
    { guildId: 1, bookId: 1, userId: 1 },
    {
      name: "rating_by_book_and_member",
      unique: true,
      partialFilterExpression: { documentType: "rating", bookId: { $type: "objectId" } },
    },
  );
}
