import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ObjectId } from "mongodb";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/book-bot-test";
const { mongoClient } = await import("../dist/mongo.js");
const { findBookByInput } = await import("../dist/book-club.js");
const commands = Object.fromEntries(await Promise.all([
  "rate-book", "view-rating", "remove-rating", "delete-book", "book-reviews", "update-book",
].map(async (name) => [name, await import(`../dist/commands/${name}.js`)])));
const {
  buildBookReviewsMessage, buildRatingListMessage, buildBookLeaderboardMessage,
  getBookRatingSummary, invalidateRatingViewsCache,
} = await import("../dist/rating-views.js");

const guildId = "id-test";
const bookId = new ObjectId("000000000000000000000001");
const otherBookId = new ObjectId("000000000000000000000002");
const foreignBookId = new ObjectId("000000000000000000000003");
const member = { id: "reader-1", username: "Reader One", toString: () => "<@reader-1>" };
let documents;
let operations;

function equal(left, right) {
  return left instanceof ObjectId ? left.equals(right) : left === right;
}

function matches(document, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((condition) => matches(document, condition));
    if (value && typeof value === "object" && "$in" in value) return value.$in.some((item) => equal(item, document[key]));
    if (value && typeof value === "object" && "$regex" in value) return new RegExp(value.$regex, value.$options).test(document[key] ?? "");
    if (value && typeof value === "object" && "$gte" in value) return document[key] >= value.$gte;
    return equal(value, document[key]);
  });
}

function cursor(source) {
  let result = [...source];
  return {
    collation() { return this; },
    sort(order) {
      result.sort((left, right) => {
        for (const [key, direction] of Object.entries(order)) {
          if (left[key] < right[key]) return -direction;
          if (left[key] > right[key]) return direction;
        }
        return 0;
      });
      return this;
    },
    skip(count) { result = result.slice(count); return this; },
    limit(count) { result = result.slice(0, count); return this; },
    async toArray() { return result.map((document) => ({ ...document })); },
  };
}

const collection = {
  async findOne(query) { return documents.find((document) => matches(document, query)) ?? null; },
  find(query) { return cursor(documents.filter((document) => matches(document, query))); },
  async countDocuments(query) { return documents.filter((document) => matches(document, query)).length; },
  async updateOne(query, update) {
    operations.push({ query, update });
    let document = documents.find((document) => matches(document, query));
    if (!document) {
      document = { _id: new ObjectId(), ...query, ...update.$setOnInsert };
      documents.push(document);
    }
    Object.assign(document, update.$set);
    return { matchedCount: 1 };
  },
  async updateMany(query, update) {
    documents.filter((document) => matches(document, query)).forEach((document) => Object.assign(document, update.$set));
  },
  async deleteOne(query) {
    const index = documents.findIndex((document) => matches(document, query));
    if (index >= 0) documents.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  },
  aggregate(stages) {
    let result = documents;
    for (const stage of stages) {
      if (stage.$match) result = result.filter((document) => matches(document, stage.$match));
      if (stage.$sort) {
        // Ranking order is irrelevant to the ID association checks in this file.
        result = [...result];
      }
      if (stage.$group) {
        const groups = new Map();
        for (const document of result) {
          const id = stage.$group._id === null ? null : document[stage.$group._id.slice(1)];
          const key = id?.toString() ?? "all";
          groups.set(key, { id, values: [...(groups.get(key)?.values ?? []), document] });
        }
        result = [...groups.values()].map(({ id, values }) => {
          const averageRating = values.reduce((sum, value) => sum + value.rating, 0) / values.length;
          return {
            _id: id, averageRating, ratingCount: values.length,
            bookTitle: values[0].bookTitle, author: values[0].author,
            ratingSpread: Math.sqrt(values.reduce((sum, value) => sum + (value.rating - averageRating) ** 2, 0) / values.length),
          };
        });
      }
    }
    return cursor(result);
  },
};

const originalDb = mongoClient.db;
const originalWithSession = mongoClient.withSession;
before(() => {
  mongoClient.db = () => ({ collection: () => collection });
  mongoClient.withSession = (callback) => callback({ withTransaction: (action) => action() });
});
beforeEach(() => {
  const book = {
    _id: bookId, documentType: "book", guildId, title: "Shared Title", normalizedTitle: "shared title",
    author: "First Author", imageUrl: "https://example.com/first.jpg", selectedAt: new Date("2025-01-01"),
  };
  const rating = {
    _id: new ObjectId("000000000000000000000011"), documentType: "rating", guildId, bookId,
    normalizedTitle: "old title", bookTitle: "Old Title", author: "Old Author", userId: member.id,
    username: member.username, rating: 9, review: "First book review.",
    createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-02"),
  };
  documents = [
    book,
    { ...book, _id: otherBookId, author: "Second Author", imageUrl: "https://example.com/second.jpg" },
    { ...book, _id: foreignBookId, guildId: "other-server" },
    rating,
    { ...rating, _id: new ObjectId("000000000000000000000012"), bookId: otherBookId, rating: 2, review: "Second book review." },
    { ...rating, _id: new ObjectId("000000000000000000000013"), userId: "reader-2", username: "Reader Two", rating: 7 },
    { ...rating, _id: new ObjectId("000000000000000000000014"), guildId: "other-server", bookId: foreignBookId, rating: 10 },
  ];
  operations = [];
  invalidateRatingViewsCache(guildId);
});
after(async () => {
  mongoClient.db = originalDb;
  mongoClient.withSession = originalWithSession;
  await mongoClient.close();
});

async function execute(name, options = {}) {
  const interaction = {
    guildId, channelId: "channel", user: member,
    options: {
      getString: (name) => options[name] ?? null,
      getNumber: (name) => options[name],
      getUser: () => null,
    },
    async deferReply() {},
    async reply(message) { this.message = message; },
    async editReply(message) { this.message = message; },
  };
  await commands[name].execute(interaction);
  interaction.message.embeds?.forEach((embed) => embed.toJSON());
  return interaction.message;
}

for (const name of Object.keys(commands)) {
  test(`${name} autocomplete returns stable IDs for duplicate and long titles`, async () => {
    documents[0].title = "Shared Title " + "x".repeat(150);
    let choices;
    await commands[name].autocomplete({ guildId, options: { getFocused: () => "Shared" },
      async respond(response) { choices = response; } });
    assert.equal(choices.length, 2);
    assert.deepEqual(new Set(choices.map((choice) => choice.value)), new Set([bookId.toString(), otherBookId.toString()]));
    assert.ok(choices.every((choice) => choice.name.length <= 100));
  });
}

test("title lookup rejects ambiguity and IDs cannot select a book in another server", async () => {
  assert.equal(await findBookByInput(guildId, "Shared Title"), null);
  assert.equal(await findBookByInput(guildId, foreignBookId.toString()), null);
  assert.ok((await findBookByInput(guildId, bookId.toString()))._id.equals(bookId));
  documents[1].normalizedTitle = "different title";
  assert.ok((await findBookByInput(guildId, " SHARED   TITLE "))._id.equals(bookId));
});

test("rating a renamed book edits the original member record without merging another book", async () => {
  const original = { ...documents[3] };
  const other = { ...documents[4] };
  await execute("rate-book", { title: bookId.toString(), rating: 8, review: "Updated review." });
  assert.equal(documents.length, 7);
  assert.ok(documents[3]._id.equals(original._id));
  assert.equal(documents[3].createdAt, original.createdAt);
  assert.equal(documents[3].rating, 8);
  assert.equal(documents[3].review, "Updated review.");
  assert.deepEqual(documents[4], other);
  assert.ok(operations[0].query.bookId.equals(bookId));
  assert.equal(operations[0].query.normalizedTitle, undefined);
});

test("new member ratings store a BSON book ID", async () => {
  documents = documents.filter((document) => !(document.documentType === "rating" && document.userId === member.id && document.bookId.equals(bookId)));
  await execute("rate-book", { title: bookId.toString(), rating: 6, review: "New rating." });
  const created = documents.find((document) => document.documentType === "rating" && document.userId === member.id && document.bookId.equals(bookId));
  assert.equal(created.rating, 6);
  assert.ok(created.createdAt instanceof Date);
  assert.ok(created.bookId instanceof ObjectId);
});

test("reviews, individual ratings, averages, and rating lists use IDs after title changes", async () => {
  assert.deepEqual(await getBookRatingSummary(guildId, bookId), { averageRating: 8, ratingCount: 2 });
  assert.deepEqual(await getBookRatingSummary(guildId, otherBookId), { averageRating: 2, ratingCount: 1 });
  const reviews = await buildBookReviewsMessage(guildId, bookId.toString(), 0);
  assert.equal(reviews.totalRatings, 2);
  assert.ok(reviews.embeds[0].data.fields.every((field) => !field.value.includes("Second book review.")));
  const view = await execute("view-rating", { title: otherBookId.toString() });
  assert.equal(view.embeds[0].data.fields.find((field) => field.name === "Rating").value, "**2.0/10**");
  const list = await buildRatingListMessage(guildId, member.id, member.toString(), 0);
  assert.equal(list.totalRatings, 2);
  assert.equal(list.embeds[0].data.title, "Shared Title");
  assert.equal(list.embeds[0].data.image.url, "https://example.com/first.jpg");
  assert.match(list.embeds[0].data.fields[0].value, /Club average: \*\*8\.0\/10\*\* from 2 ratings/);
});

test("leaderboards keep separate books with the same title and use current book metadata", async () => {
  for (const ranking of ["highest-rated", "most-rated"]) {
    const message = await buildBookLeaderboardMessage(guildId, 0, ranking);
    assert.equal(message.totalBooks, 2);
    const fields = message.embeds[0].data.fields;
    assert.ok(fields.some((field) => field.value.includes("First Author") && field.value.includes("8.0/10")));
    assert.ok(fields.some((field) => field.value.includes("Second Author") && field.value.includes("2.0/10")));
    assert.ok(fields.every((field) => !field.name.includes("Old Title")));
  }
  const divisive = await buildBookLeaderboardMessage(guildId, 0, "most-divisive");
  assert.equal(divisive.totalBooks, 1);
  assert.match(divisive.embeds[0].data.fields[0].value, /First Author/);
});

test("removing a rating and updating an author affect only the selected book ID", async () => {
  const other = { ...documents[4] };
  await execute("update-book", { title: bookId.toString(), author: "Corrected Author" });
  assert.equal(documents[3].author, "Corrected Author");
  assert.deepEqual(documents[4], other);
  await execute("remove-rating", { title: bookId.toString() });
  assert.equal(documents.some((document) => document._id?.toString() === "000000000000000000000011"), false);
  assert.ok(documents.some((document) => document._id?.equals(other._id)));
});

test("deletion checks protect rated books and delete only an unrated book with the same title", async () => {
  const denied = await execute("delete-book", { title: bookId.toString() });
  assert.match(denied.content, /cannot delete/);
  documents = documents.filter((document) => !(document.documentType === "rating" && document.bookId.equals(otherBookId)));
  await execute("delete-book", { title: otherBookId.toString() });
  assert.equal(documents.some((document) => document._id.equals(otherBookId)), false);
  assert.ok(documents.some((document) => document._id.equals(bookId)));
});
