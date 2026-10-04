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
  handleBookReviewsPage,
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
let ratingCountsByTitle = new Map();

function matches(document, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "_id") return document._id?.equals(value) ?? false;
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
      Array.from({ length: ratingCountsByTitle.get(book.normalizedTitle) ?? ratingsPerBook }, (_, index) => ({
        documentType: "rating",
        guildId: book.guildId,
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
  ratingCountsByTitle = new Map();
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

for (const count of [0, 1]) {
  test(`a single club book with ${count} reviews omits book navigation`, async () => {
    availableBooks = [books[2]];
    ratingsPerBook = count;
    const message = await buildBookReviewsMessage(guildId, books[2]._id.toString(), 0);
    assert.equal(message.components.length, 0);
    assert.equal(message.totalRatings, count);
    assert.equal(message.embeds[0].data.title, books[2].title);
    if (count === 0) assert.match(message.embeds[0].data.description, /No reviews yet\./);
    assertValidButtons(message);
  });
}

test("/book-reviews shows the book card and navigation when no books have reviews", async () => {
  ratingsPerBook = 0;
  availableBooks = books.map((book) => ({ ...book, imageUrl: "https://example.com/cover.jpg" }));
  for (const [index, book] of availableBooks.entries()) {
    let message;
    await execute({
      guildId,
      options: { getString: () => book.normalizedTitle },
      async deferReply() {},
      async editReply(reply) { message = reply; },
    });
    const embed = message.embeds[0].data;
    assert.equal(embed.title, book.title);
    assert.equal(embed.description, `by **${book.author}**\nNo reviews yet.`);
    assert.equal(embed.thumbnail.url, book.imageUrl);
    assert.equal(embed.fields?.length ?? 0, 0);
    assert.match(embed.footer.text, new RegExp(`Book ${index + 1} of 3`));
    assert.equal(message.components.length, 1);
    const [navigation] = assertValidButtons(message);
    assert.equal(navigation.components[0].disabled, index === 0);
    assert.equal(navigation.components[2].disabled, index === availableBooks.length - 1);
  }
});

test("book navigation includes unreviewed books and stays within the current server", async () => {
  availableBooks = [...books, {
    ...books[0],
    _id: new ObjectId("000000000000000000000004"),
    guildId: "other-server",
  }];
  ratingCountsByTitle.set(books[1].normalizedTitle, 0);
  const message = await buildBookReviewsMessage(guildId, books[0]._id.toString(), 0);
  const [navigation] = assertValidButtons(message);
  let reply;
  await handleBookReviewsBook({
    guildId,
    customId: navigation.components[2].custom_id,
    async deferUpdate() {},
    async editReply(message) { reply = message; },
  });
  assert.equal(reply.embeds[0].data.title, books[1].title);
  assert.match(reply.embeds[0].data.description, /No reviews yet\./);
  const [unreviewedNavigation] = assertValidButtons(reply);
  assert.equal(unreviewedNavigation.components[1].label, "2/3 Books");
  for (const [buttonIndex, bookIndex] of [[0, 0], [2, 2]]) {
    await handleBookReviewsBook({
      guildId,
      customId: unreviewedNavigation.components[buttonIndex].custom_id,
      async deferUpdate() {},
      async editReply(message) { reply = message; },
    });
    assert.equal(reply.embeds[0].data.title, books[bookIndex].title);
    assert.match(reply.embeds[0].data.description, /Club average: \*\*8\.0\/10\*\* from 1 rating/);
    assertValidButtons(reply);
  }
});

test("existing review page buttons still show the book after its last review is removed", async () => {
  ratingsPerBook = 4;
  const message = await buildBookReviewsMessage(guildId, books[0]._id.toString(), 0);
  const [reviews] = assertValidButtons(message);
  ratingsPerBook = 0;
  invalidateRatingViewsCache(guildId);
  let reply;
  await handleBookReviewsPage({
    guildId,
    customId: reviews.components[2].custom_id,
    async deferUpdate() {},
    async editReply(message) { reply = message; },
  });
  assert.equal(reply.embeds[0].data.title, books[0].title);
  assert.match(reply.embeds[0].data.description, /No reviews yet\./);
  assert.equal(reply.embeds[0].data.fields?.length ?? 0, 0);
  assert.equal(reply.components.length, 1);
  assertValidButtons(reply);
});

test("book navigation still reports a deleted book", async () => {
  availableBooks = [books[0], books[2]];
  let reply;
  await handleBookReviewsBook({
    guildId,
    customId: `book-reviews-book:${books[1]._id}:next`,
    async deferUpdate() {},
    async editReply(message) { reply = message; },
  });
  assert.equal(reply.content, "That book could not be found anymore.");
  assert.deepEqual(reply.embeds, []);
  assert.deepEqual(reply.components, []);
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
