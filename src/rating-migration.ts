import { BSON, ObjectId, type Document } from "mongodb";

export interface RatingMigrationMapping {
  ratingId: ObjectId;
  bookId: ObjectId;
  needsUpdate: boolean;
}

function titleKey(document: Document) {
  return JSON.stringify([document.guildId ?? null, document.normalizedTitle ?? null]);
}

export function buildRatingMigrationPlan(documents: Document[]) {
  const books = documents.filter((document) => document.documentType === "book");
  const ratings = documents.filter((document) => document.documentType === "rating");
  const byId = new Map(books.map((book) => [book._id.toString(), book]));
  const byTitle = new Map<string, Document[]>();
  for (const book of books) {
    const key = titleKey(book);
    byTitle.set(key, [...(byTitle.get(key) ?? []), book]);
  }
  const mappings: RatingMigrationMapping[] = [];
  const issues: string[] = [];
  const memberKeys = new Set<string>();
  for (const rating of ratings) {
    if (!(rating._id instanceof ObjectId) || typeof rating.userId !== "string" || !rating.userId) {
      issues.push(`Rating ${rating._id} is missing a valid record ID or member ID.`);
      continue;
    }
    let candidates: Document[];
    if (rating.bookId != null) {
      if (!(rating.bookId instanceof ObjectId)) {
        issues.push(`Rating ${rating._id} has a bookId that is not a MongoDB ObjectId.`);
        continue;
      }
      const book = byId.get(rating.bookId.toString());
      candidates = book && (book.guildId ?? null) === (rating.guildId ?? null) ? [book] : [];
    } else {
      candidates = typeof rating.normalizedTitle === "string"
        ? byTitle.get(titleKey(rating)) ?? []
        : [];
    }
    if (candidates.length !== 1 || !(candidates[0]._id instanceof ObjectId)) {
      issues.push(`Rating ${rating._id} has ${candidates.length} matching books; it needs one unambiguous match.`);
      continue;
    }
    const book = candidates[0];
    const memberKey = JSON.stringify([rating.guildId ?? null, book._id.toString(), rating.userId]);
    if (memberKeys.has(memberKey)) {
      issues.push(`More than one rating exists for member ${rating.userId} and book ${book._id}.`);
    }
    memberKeys.add(memberKey);
    mappings.push({ ratingId: rating._id, bookId: book._id, needsUpdate: rating.bookId == null });
  }
  for (const document of documents) {
    if (document.documentType !== "rating" && document.documentType !== "book" && "rating" in document) {
      issues.push(`Record ${document._id} looks like a legacy rating without documentType: rating.`);
    }
  }
  return { books: books.length, ratings: ratings.length, mappings, issues };
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedValue(item)]));
  }
  return value;
}

function canonical(value: unknown) {
  return JSON.stringify(sortedValue(BSON.EJSON.serialize(value, { relaxed: false })));
}

export function compareMigrationDocuments(before: Document[], after: Document[]) {
  const beforeById = new Map(before.map((document) => [document._id.toString(), document]));
  const afterById = new Map(after.map((document) => [document._id.toString(), document]));
  const addedIds = [...afterById.keys()].filter((id) => !beforeById.has(id));
  const missingIds = [...beforeById.keys()].filter((id) => !afterById.has(id));
  const changedDocuments: { id: string; fields: string[] }[] = [];
  for (const [id, original] of beforeById) {
    const current = afterById.get(id);
    if (!current) continue;
    const fields = [...new Set([...Object.keys(original), ...Object.keys(current)])].filter((field) => {
      if (field === "bookId" && original.documentType === "rating" && current.documentType === "rating") return false;
      return Object.prototype.hasOwnProperty.call(original, field) !== Object.prototype.hasOwnProperty.call(current, field) ||
        canonical(original[field]) !== canonical(current[field]);
    });
    if (fields.length) changedDocuments.push({ id, fields });
  }
  return { ok: !addedIds.length && !missingIds.length && !changedDocuments.length, addedIds, missingIds, changedDocuments };
}

export function verifyRatingMigration(before: Document[], after: Document[], mappings: RatingMigrationMapping[]) {
  const comparison = compareMigrationDocuments(before, after);
  const byId = new Map(after.map((document) => [document._id.toString(), document]));
  const invalidBookIds: string[] = [];
  for (const mapping of mappings) {
    const rating = byId.get(mapping.ratingId.toString());
    const book = byId.get(mapping.bookId.toString());
    if (!(rating?.bookId instanceof ObjectId) || !rating.bookId.equals(mapping.bookId) ||
        book?.documentType !== "book" || rating.documentType !== "rating" ||
        (book.guildId ?? null) !== (rating.guildId ?? null)) {
      invalidBookIds.push(mapping.ratingId.toString());
    }
  }
  return { ...comparison, ok: comparison.ok && !invalidBookIds.length, checkedRatings: mappings.length, invalidBookIds };
}
