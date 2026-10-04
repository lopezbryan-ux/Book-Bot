import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import { buildRatingMigrationPlan, compareMigrationDocuments, verifyRatingMigration } from "../dist/rating-migration.js";

const bookId = new ObjectId("000000000000000000000001");
const otherBookId = new ObjectId("000000000000000000000002");
const ratingId = new ObjectId("000000000000000000000003");
const book = { _id: bookId, documentType: "book", guildId: "club", title: "A Book", normalizedTitle: "a book" };
const rating = {
  _id: ratingId, documentType: "rating", guildId: "club", normalizedTitle: "a book",
  userId: "member", rating: 9, review: "Original full review.\nKeep every character.",
  createdAt: new Date("2025-01-01"), updatedAt: new Date("2026-01-01"), extraMetadata: { source: "original" },
};

test("migration maps legacy ratings by server and title without mutating source records", () => {
  const original = structuredClone(rating);
  const plan = buildRatingMigrationPlan([book, rating, { ...book, _id: otherBookId, guildId: "other-club" }]);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.mappings.length, 1);
  assert.ok(plan.mappings[0].bookId.equals(bookId));
  assert.equal(plan.mappings[0].needsUpdate, true);
  assert.equal(rating.review, original.review);
  assert.equal("bookId" in rating, false);
});

test("migration is idempotent and existing IDs work after a title correction", () => {
  const migrated = { ...rating, bookId };
  const plan = buildRatingMigrationPlan([{ ...book, title: "Corrected", normalizedTitle: "corrected" }, migrated]);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.mappings[0].needsUpdate, false);
});

for (const [name, documents] of [
  ["missing books", [rating]],
  ["ambiguous titles", [book, { ...book, _id: otherBookId }, rating]],
  ["books in other servers", [{ ...book, guildId: "other-club" }, rating]],
  ["existing cross-server IDs", [{ ...book, guildId: "other-club" }, { ...rating, bookId }]],
  ["string book IDs", [book, { ...rating, bookId: bookId.toString() }]],
  ["duplicate member ratings", [book, rating, { ...rating, _id: new ObjectId() }]],
  ["unclassified legacy ratings", [book, { ...rating, documentType: undefined }]],
]) {
  test(`migration refuses ${name}`, () => {
    assert.ok(buildRatingMigrationPlan(documents).issues.length > 0);
  });
}

test("verification accepts only the added book link while retaining every original field", () => {
  const before = [book, rating];
  const plan = buildRatingMigrationPlan(before);
  const after = [book, { ...rating, bookId }];
  assert.equal(verifyRatingMigration(before, after, plan.mappings).ok, true);
  assert.equal(verifyRatingMigration(before, after, plan.mappings).checkedRatings, 1);
});

for (const [field, value] of [
  ["rating", 8], ["review", "Altered text"], ["userId", "other-member"],
  ["updatedAt", new Date("2026-02-01")], ["extraMetadata", { source: "changed" }],
]) {
  test(`verification detects altered ${field}`, () => {
    const result = verifyRatingMigration([book, rating], [book, { ...rating, bookId, [field]: value }],
      buildRatingMigrationPlan([book, rating]).mappings);
    assert.equal(result.ok, false);
    assert.ok(result.changedDocuments[0].fields.includes(field));
  });
}

test("verification detects missing, added, wrongly linked, and mistyped records", () => {
  const before = [book, rating];
  const mappings = buildRatingMigrationPlan(before).mappings;
  assert.equal(verifyRatingMigration(before, [book], mappings).ok, false);
  assert.equal(verifyRatingMigration(before, [book, { ...rating, bookId }, { ...book, _id: otherBookId }], mappings).ok, false);
  assert.equal(verifyRatingMigration(before, [book, { ...rating, bookId: otherBookId }], mappings).ok, false);
  assert.equal(verifyRatingMigration(before, [book, { ...rating, bookId: bookId.toString() }], mappings).ok, false);
  assert.equal(verifyRatingMigration(before, [book, rating], mappings).ok, false);
  assert.equal(compareMigrationDocuments(before, [{ ...book, title: "Changed" }, rating]).ok, false);
});
