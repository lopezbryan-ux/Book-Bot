import {
  BOOK_BOT_COLLECTION_NAME,
  BOOK_BOT_DB_NAME,
  BOOK_NOMINATIONS_COLLECTION_NAME,
  BOOK_POLLS_COLLECTION_NAME,
  mongoClient,
} from "./mongo.js";

export interface NominationDocument {
  nominationId: string;
  documentType: "nomination";
  guildId: string | null;
  channelId: string;
  title: string;
  normalizedTitle: string;
  author: string | null;
  reason: string | null;
  status: "nominated" | "selected";
  nominatedBy: string;
  nominatedByUsername: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PollOption {
  nominationId: string;
  title: string;
  normalizedTitle: string;
  author: string | null;
  nominatedBy: string;
  reason: string | null;
}

export interface PollDocument {
  pollId: string;
  documentType: "poll";
  guildId: string | null;
  channelId: string;
  messageId: string | null;
  status: "active" | "closed";
  options: PollOption[];
  votes: Record<string, number>;
  createdBy: string;
  createdByUsername: string;
  winner: PollOption | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface BookDocument {
  documentType: "book";
  guildId: string | null;
  title: string;
  normalizedTitle: string;
  author: string | null;
  source: "manual" | "poll";
  sourcePollId: string | null;
  note: string | null;
  addedBy: string | null;
  addedByUsername: string | null;
  selectedAt: Date;
  updatedAt: Date;
}

export function normalizeTitle(title: string) {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function formatBookTitle(title: string, author?: string | null) {
  return author ? `${title} by ${author}` : title;
}

export function getBookClubCollections() {
  const db = mongoClient.db(BOOK_BOT_DB_NAME);

  return {
    books: db.collection<BookDocument>(BOOK_BOT_COLLECTION_NAME),
    nominations: db.collection<NominationDocument>(BOOK_NOMINATIONS_COLLECTION_NAME),
    polls: db.collection<PollDocument>(BOOK_POLLS_COLLECTION_NAME),
  };
}
