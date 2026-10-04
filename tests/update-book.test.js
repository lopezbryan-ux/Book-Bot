import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ObjectId } from "mongodb";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/book-bot-test";
const { mongoClient } = await import("../dist/mongo.js");
const { autocomplete, data, execute } = await import("../dist/commands/update-book.js");

const guildId = "update-book-test";
const bookId = new ObjectId("000000000000000000000001");
const otherBookId = new ObjectId("000000000000000000000002");
const otherGuildBookId = new ObjectId("000000000000000000000003");
let documents;
let operations;
let interaction;
let transactionCount;

function matches(document, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((condition) => matches(document, condition));
    if (value instanceof ObjectId) return document[key]?.equals(value) ?? false;
    if (value && typeof value === "object" && "$ne" in value) {
      return value.$ne instanceof ObjectId ? !value.$ne.equals(document[key]) : document[key] !== value.$ne;
    }
    if (value && typeof value === "object" && "$regex" in value) {
      return new RegExp(value.$regex, value.$options).test(document[key] ?? "");
    }
    return document[key] === value;
  });
}

function record(operation, options) {
  if (interaction) assert.equal(interaction.deferred, true, "Acknowledge Discord before database work");
  operations.push({ operation, session: options?.session });
}

const collection = {
  async findOne(query, options) {
    record("findOne", options);
    const document = documents.find((document) => matches(document, query));
    return document ? { ...document } : null;
  },
  find(query, options) {
    record("find", options);
    let result = documents.filter((document) => matches(document, query));
    return {
      collation() { return this; },
      sort() { result.sort((left, right) => left.title.localeCompare(right.title)); return this; },
      limit(count) { result = result.slice(0, count); return this; },
      async toArray() { return result; },
    };
  },
  async updateOne(query, update, options) {
    record("updateOne", options);
    const document = documents.find((document) => matches(document, query));
    if (document) Object.assign(document, update.$set);
    return { matchedCount: document ? 1 : 0 };
  },
  async updateMany(query, update, options) {
    record("updateMany", options);
    const matchesQuery = documents.filter((document) => matches(document, query));
    matchesQuery.forEach((document) => Object.assign(document, update.$set));
    return { matchedCount: matchesQuery.length };
  },
};
const session = {
  async withTransaction(callback) {
    transactionCount += 1;
    return callback();
  },
};

const originalDb = mongoClient.db;
const originalWithSession = mongoClient.withSession;
before(() => {
  mongoClient.db = () => ({ collection: () => collection });
  mongoClient.withSession = (callback) => callback(session);
});
beforeEach(() => {
  const selectedAt = new Date("2025-01-01T00:00:00Z");
  const book = {
    _id: bookId,
    documentType: "book",
    guildId,
    title: "The Cipher",
    normalizedTitle: "the cipher",
    author: "Original Author",
    imageUrl: "https://example.com/old-cover.jpg",
    source: "poll",
    sourcePollId: "original-poll",
    note: "Our October selection",
    addedBy: "original-member",
    addedByUsername: "Original Member",
    selectedAt,
    updatedAt: selectedAt,
  };
  const rating = {
    documentType: "rating",
    bookId,
    guildId,
    normalizedTitle: book.normalizedTitle,
    bookTitle: book.title,
    author: book.author,
    userId: "reader-1",
    username: "Reader One",
    rating: 9,
    review: "Keep this review.",
    createdAt: selectedAt,
    updatedAt: selectedAt,
  };
  documents = [
    book,
    { ...book, _id: otherBookId, title: "Another Book", normalizedTitle: "another book" },
    { ...book, _id: otherGuildBookId, guildId: "other-server" },
    rating,
    { ...rating, userId: "reader-2", rating: 7 },
    { ...rating, bookId: otherBookId, normalizedTitle: "another book", bookTitle: "Another Book" },
    { ...rating, bookId: otherGuildBookId, guildId: "other-server" },
  ];
  operations = [];
  interaction = null;
  transactionCount = 0;
});
after(async () => {
  mongoClient.db = originalDb;
  mongoClient.withSession = originalWithSession;
  await mongoClient.close();
});

async function runCommand(options) {
  interaction = {
    guildId,
    user: { username: "Editor" },
    options: { getString: (name) => options[name] ?? null },
    deferred: false,
    async deferReply() { this.deferred = true; },
    async reply(message) { this.message = message; },
    async editReply(message) { this.message = message; },
  };
  await execute(interaction);
  interaction.message.embeds?.forEach((embed) => embed.toJSON());
  return interaction.message;
}

test("the command offers book selection and optional new title, author, and image URL", () => {
  const command = data.toJSON();
  assert.equal(command.name, "update-book");
  assert.deepEqual(command.options.map((option) => option.name), ["title", "new-title", "author", "image-url"]);
  assert.equal(command.options[0].required, true);
  assert.equal(command.options[0].autocomplete, true);
  assert.equal(command.options[1].required ?? false, false);
  assert.equal(command.options[1].max_length, 256);
});

test("title changes preserve the book ID, history, cover, and every member's review and score", async () => {
  const originalBook = { ...documents[0] };
  const originalRatings = documents.slice(3).map((rating) => ({ ...rating }));
  const unrelatedBooks = documents.slice(1, 3).map((book) => ({ ...book }));
  const reply = await runCommand({ title: bookId.toString(), "new-title": "  The   Corrected Title  " });

  assert.deepEqual(documents[0], {
    ...originalBook, title: "The   Corrected Title", normalizedTitle: "the corrected title", updatedAt: documents[0].updatedAt,
  });
  assert.ok(documents[0].updatedAt > originalBook.updatedAt);
  assert.deepEqual(documents.slice(1, 3), unrelatedBooks);
  assert.deepEqual(documents.slice(3), originalRatings.map((rating, index) => index < 2
    ? { ...rating, bookTitle: "The   Corrected Title", normalizedTitle: "the corrected title" }
    : rating));
  assert.equal(reply.embeds[0].data.description, "**The   Corrected Title**");
  assert.equal(transactionCount, 1);
  assert.ok(operations.every((operation) => operation.session === session));
});

test("title, author, and cover can be updated together using the current title", async () => {
  const originalRatings = documents.slice(3).map((rating) => ({ ...rating }));
  await runCommand({
    title: "  THE   CIPHER  ", "new-title": "The Cipher (1991)", author: "Kathe Koja",
    "image-url": "https://example.com/new-cover.jpg",
  });
  assert.ok(documents[0]._id.equals(bookId));
  assert.equal(documents[0].title, "The Cipher (1991)");
  assert.equal(documents[0].author, "Kathe Koja");
  assert.equal(documents[0].imageUrl, "https://example.com/new-cover.jpg");
  assert.deepEqual(documents.slice(3), originalRatings.map((rating, index) => index < 2
    ? { ...rating, bookTitle: "The Cipher (1991)", normalizedTitle: "the cipher (1991)", author: "Kathe Koja" }
    : rating));
  assert.equal(operations.filter((operation) => operation.operation === "updateMany").length, 1);
});

test("duplicate normalized titles are rejected before changing any book or rating", async () => {
  const originalDocuments = documents.map((document) => ({ ...document }));
  const reply = await runCommand({ title: bookId.toString(), "new-title": "  ANOTHER   BOOK  ", author: "New Author" });
  assert.match(reply.content, /title already exists/);
  assert.deepEqual(documents, originalDocuments);
  assert.equal(operations.some((operation) => operation.operation.startsWith("update")), false);
});

test("a case-only title correction does not conflict with the selected book", async () => {
  await runCommand({ title: bookId.toString(), "new-title": "THE CIPHER" });
  assert.equal(documents[0].title, "THE CIPHER");
  assert.equal(documents[0].normalizedTitle, "the cipher");
  assert.equal(documents[3].bookTitle, "THE CIPHER");
});

test("a title used in another server does not block renaming or alter its ratings", async () => {
  documents[2].title = "Foreign Title";
  documents[2].normalizedTitle = "foreign title";
  const originalForeignBook = { ...documents[2] };
  const originalForeignRating = { ...documents[6] };
  await runCommand({ title: bookId.toString(), "new-title": "Foreign Title" });
  assert.equal(documents[0].title, "Foreign Title");
  assert.deepEqual(documents[2], originalForeignBook);
  assert.deepEqual(documents[6], originalForeignRating);
});

test("the current title is a no-op that preserves book and rating timestamps", async () => {
  const originalDocuments = documents.map((document) => ({ ...document }));
  const reply = await runCommand({ title: bookId.toString(), "new-title": "  The Cipher  " });
  assert.match(reply.content, /nothing to update/);
  assert.deepEqual(documents, originalDocuments);
  assert.equal(operations.some((operation) => operation.operation.startsWith("update")), false);
});

test("author updates preserve the title, cover, book history, and member reviews", async () => {
  const originalBook = { ...documents[0] };
  const originalRatings = documents.slice(3).map((rating) => ({ ...rating }));
  const unrelatedBooks = documents.slice(1, 3).map((book) => ({ ...book }));
  const reply = await runCommand({ title: bookId.toString(), author: "  Kathe Koja  " });

  assert.deepEqual(documents[0], { ...originalBook, author: "Kathe Koja", updatedAt: documents[0].updatedAt });
  assert.ok(documents[0].updatedAt > originalBook.updatedAt);
  assert.deepEqual(documents.slice(1, 3), unrelatedBooks);
  assert.deepEqual(documents.slice(3), originalRatings.map((rating, index) =>
    index < 2 ? { ...rating, author: "Kathe Koja" } : rating,
  ));
  assert.equal(reply.embeds[0].data.title, "Updated club book");
  assert.equal(transactionCount, 1);
  assert.ok(operations.every((operation) => operation.session === session));
});

test("image-only updates keep the current author and all ratings unchanged", async () => {
  const originalBook = { ...documents[0] };
  const originalRatings = documents.slice(3).map((rating) => ({ ...rating }));
  await runCommand({ title: bookId.toString(), "image-url": "https://example.com/new-cover.jpg" });

  assert.deepEqual(documents[0], {
    ...originalBook,
    imageUrl: "https://example.com/new-cover.jpg",
    updatedAt: documents[0].updatedAt,
  });
  assert.deepEqual(documents.slice(3), originalRatings);
  assert.equal(operations.some((operation) => operation.operation === "updateMany"), false);
});

test("both editable fields can be updated using a manually entered title", async () => {
  const reply = await runCommand({
    title: "  THE   CIPHER  ",
    author: "Kathe Koja",
    "image-url": "  https://example.com/new-cover.jpg  ",
  });
  assert.equal(documents[0].title, "The Cipher");
  assert.equal(documents[0].normalizedTitle, "the cipher");
  assert.equal(documents[0].author, "Kathe Koja");
  assert.equal(documents[0].imageUrl, "https://example.com/new-cover.jpg");
  assert.equal(reply.embeds[0].data.image.url, "https://example.com/new-cover.jpg");
});

for (const [name, options] of [
  ["no changes supplied", {}],
  ["blank new title", { "new-title": "   " }],
  ["blank author", { author: "   " }],
  ["blank image URL", { "image-url": "   " }],
  ["invalid image URL", { "image-url": "not-a-url" }],
  ["unsupported image URL protocol", { "image-url": "file:///tmp/cover.jpg" }],
  ["blank book selection", { title: "   ", author: "Kathe Koja" }],
]) {
  test(`rejects ${name} before any database work`, async () => {
    const originalDocuments = documents.map((document) => ({ ...document }));
    const reply = await runCommand({ title: bookId.toString(), ...options });
    assert.equal(typeof reply.content, "string");
    assert.equal(reply.embeds, undefined);
    assert.equal(operations.length, 0);
    assert.deepEqual(documents, originalDocuments);
  });
}

test("missing books and books in other servers cannot be updated", async () => {
  const originalDocuments = documents.map((document) => ({ ...document }));
  for (const title of ["Unknown Book", otherGuildBookId.toString()]) {
    const reply = await runCommand({ title, author: "Kathe Koja" });
    assert.equal(reply.content, "That book is not in the club book list.");
  }
  assert.deepEqual(documents, originalDocuments);
  assert.equal(operations.some((operation) => operation.operation.startsWith("update")), false);
});

test("unchanged details do not rewrite book or rating timestamps", async () => {
  const originalDocuments = documents.map((document) => ({ ...document }));
  const reply = await runCommand({ title: bookId.toString(), author: "Original Author" });
  assert.match(reply.content, /nothing to update/);
  assert.deepEqual(documents, originalDocuments);
  assert.equal(operations.some((operation) => operation.operation.startsWith("update")), false);
});

test("autocomplete searches title and author within the current server", async () => {
  for (const focusedValue of ["cipher", "original author"]) {
    let choices;
    await autocomplete({
      guildId,
      options: { getFocused: () => focusedValue },
      async respond(response) { choices = response; },
    });
    assert.ok(choices.some((choice) => choice.value === bookId.toString()));
    assert.equal(choices.some((choice) => choice.value === otherGuildBookId.toString()), false);
  }
});

test("autocomplete escapes regex punctuation and keeps long-title selections usable", async () => {
  documents[0].title = `The Cipher (1991) ${"x".repeat(100)}`;
  let choices;
  await autocomplete({
    guildId,
    options: { getFocused: () => "(" },
    async respond(response) { choices = response; },
  });
  assert.equal(choices.length, 1);
  assert.equal(choices[0].name.length, 100);
  assert.equal(choices[0].value, bookId.toString());
  await runCommand({ title: choices[0].value, author: "Kathe Koja" });
  assert.equal(documents[0].author, "Kathe Koja");
});
