import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ObjectId } from "mongodb";

// Keep these checks offline, even when a real database is configured locally.
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/book-bot-test";
const { mongoClient } = await import("../dist/mongo.js");
const { execute } = await import("../dist/commands/book-reviews.js");
const {
  buildBookReviewsMessage,
  handleBookReviewsBook,
  invalidateRatingViewsCache,
} = await import("../dist/rating-views.js");

const guildId = "book-reviews-test";
const books = ["First Book", "Middle Book", "The Cipher"].map((title, index) => ({
  _id: new ObjectId((index + 1).toString(16).padStart(24, "0")),
  documentType: "book",
  guildId,
  title,
  normalizedTitle: title.toLowerCase(),
  author: "Test Author",
  imageUrl: null,
}));
let availableBooks = books;
let ratingsPerBook = 1;

function matches(document, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "_id") return document._id.equals(value);
    if (value && typeof value === "object" && "$in" in value) {
      return value.$in.includes(document[key]);
    }
    return document[key] === value;
  });
}

function cursor(documents) {
  let result = documents;
  return {
    sort() { return this; },
    skip(count) { result = result.slice(count); return this; },
    limit(count) { result = result.slice(0, count); return this; },
    async toArray() { return result; },
  };
}

const collection = {
  documents() {
    return [...availableBooks, ...availableBooks.flatMap((book) =>
      Array.from({ length: ratingsPerBook }, (_, index) => ({
        documentType: "rating",
        guildId,
        normalizedTitle: book.normalizedTitle,
        username: `Reader ${index + 1}`,
        rating: 8,
        review: "A test review.",
        updatedAt: new Date("2026-10-04T12:00:00Z"),
      })),
    )];
  },
  async findOne(query) {
    return this.documents().find((document) => matches(document, query)) ?? null;
  },
  find(query) {
    return cursor(this.documents().filter((document) => matches(document, query)));
  },
  async countDocuments(query) {
    return this.documents().filter((document) => matches(document, query)).length;
  },
  aggregate(stages) {
    const ratings = this.documents().filter((document) => matches(document, stages[0].$match));
    return cursor(ratings.length ? [{ averageRating: 8, ratingCount: ratings.length }] : []);
  },
  async distinct(key, query) {
    return [...new Set(this.documents().filter((document) => matches(document, query)).map((document) => document[key]))];
  },
};

const originalDb = mongoClient.db;
before(() => {
  mongoClient.db = () => ({ collection: () => collection });
});
beforeEach(() => {
  availableBooks = books;
  ratingsPerBook = 1;
  invalidateRatingViewsCache(guildId);
});
after(async () => {
  mongoClient.db = originalDb;
  await mongoClient.close();
});

function assertValidButtons(message) {
  message.embeds.forEach((embed) => embed.toJSON());
  const rows = message.components.map((row) => row.toJSON());
  const ids = rows.flatMap((row) => row.components.map((button) => button.custom_id));
  assert.equal(new Set(ids).size, ids.length, "Discord requires unique button IDs, including disabled buttons");
  ids.forEach((id) => assert.ok(id.length <= 100));
  return rows;
}

for (const [index, position] of ["first", "middle", "last"].entries()) {
  test(`/book-reviews sends valid reviews for the ${position} book`, async () => {
    let message;
    let deferred = false;
    await execute({
      guildId,
      options: { getString: () => books[index].normalizedTitle },
      async deferReply() { deferred = true; },
      async editReply(reply) { message = reply; },
    });
    assert.equal(deferred, true);
    assert.equal(message.embeds[0].data.title, books[index].title);
    const [navigation] = assertValidButtons(message);
    assert.equal(navigation.components[0].disabled, index === 0);
    assert.equal(navigation.components[1].disabled, true);
    assert.equal(navigation.components[2].disabled, index === books.length - 1);
  });
}

test("review pagination and book navigation have unique IDs together", async () => {
  ratingsPerBook = 4;
  for (const book of books) {
    for (const page of [0, 1]) {
      const message = await buildBookReviewsMessage(guildId, book._id.toString(), page);
      assert.equal(message.components.length, 2);
      assertValidButtons(message);
    }
  }
});

test("a single reviewed book omits book navigation", async () => {
  availableBooks = [books[2]];
  const message = await buildBookReviewsMessage(guildId, books[2]._id.toString(), 0);
  assert.equal(message.components.length, 0);
  assert.equal(message.totalRatings, 1);
  assertValidButtons(message);
});

test("book navigation buttons still load the intended book", async () => {
  const message = await buildBookReviewsMessage(guildId, books[1]._id.toString(), 0);
  const [navigation] = assertValidButtons(message);
  for (const [buttonIndex, bookIndex] of [[0, 0], [2, 2]]) {
    let reply;
    await handleBookReviewsBook({
      guildId,
      customId: navigation.components[buttonIndex].custom_id,
      async deferUpdate() {},
      async editReply(message) { reply = message; },
    });
    assert.equal(reply.embeds[0].data.title, books[bookIndex].title);
    assertValidButtons(reply);
  }
});

test("existing book navigation buttons remain compatible", async () => {
  let reply;
  await handleBookReviewsBook({
    guildId,
    customId: `book-reviews-book:${books[2]._id}`,
    async deferUpdate() {},
    async editReply(message) { reply = message; },
  });
  assert.equal(reply.embeds[0].data.title, "The Cipher");
  assertValidButtons(reply);
});
