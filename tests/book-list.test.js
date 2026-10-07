import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { MessageFlags } from "discord.js";
import { ObjectId } from "mongodb";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/book-bot-test";
const { mongoClient } = await import("../dist/mongo.js");
const { execute } = await import("../dist/commands/book-list.js");
const {
  buildBookListMessage,
  handleBookListPage,
  handleBookListSort,
  isBookListPageCustomId,
} = await import("../dist/book-list-view.js");

const guildId = "book-list-test";
const books = Array.from({ length: 27 }, (_, index) => ({
  _id: new ObjectId((index + 1).toString(16).padStart(24, "0")),
  documentType: "book",
  guildId,
  title: `Book ${String(index + 1).padStart(2, "0")}`,
  normalizedTitle: `book ${String(index + 1).padStart(2, "0")}`,
  author: `Author ${String(27 - index).padStart(2, "0")}`,
  selectedAt: new Date(Date.UTC(2026, 0, index + 1)),
}));
let documents;
let databaseReads;

function matchingDocuments(query) {
  return documents.filter((document) => Object.entries(query).every(([key, value]) => document[key] === value));
}

function compareDocuments(sort) {
  return (left, right) => {
    for (const [key, direction] of Object.entries(sort)) {
      const leftValue = left[key] instanceof ObjectId ? left[key].toHexString() : left[key];
      const rightValue = right[key] instanceof ObjectId ? right[key].toHexString() : right[key];
      if (leftValue < rightValue) return -direction;
      if (leftValue > rightValue) return direction;
    }
    return 0;
  };
}

const collection = {
  async countDocuments(query) {
    databaseReads++;
    return matchingDocuments(query).length;
  },
  find(query) {
    databaseReads++;
    let result = matchingDocuments(query);
    return {
      sort(sort) { result.sort(compareDocuments(sort)); return this; },
      skip(count) { result = result.slice(count); return this; },
      limit(count) { result = result.slice(0, count); return this; },
      async toArray() { return result; },
    };
  },
};

const originalDb = mongoClient.db;
before(() => {
  mongoClient.db = () => ({ collection: () => collection });
});
beforeEach(() => {
  documents = [...books].reverse();
  databaseReads = 0;
});
after(async () => {
  mongoClient.db = originalDb;
  await mongoClient.close();
});

function validateMessage(message) {
  const embed = message.embeds[0].toJSON();
  assert.ok(embed.fields.length <= 10);
  const rows = message.components.map((row) => row.toJSON());
  const ids = rows.flatMap((row) => row.components.map((component) => component.custom_id));
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach((id) => assert.ok(id.length <= 100));
  return { embed, menu: rows[0].components[0], buttons: rows[1]?.components };
}

async function updateMessage(handler, interaction) {
  let message;
  const events = [];
  await handler({
    guildId,
    ...interaction,
    async deferUpdate() { events.push("defer"); },
    async editReply(reply) { events.push("edit"); message = reply; },
  });
  assert.deepEqual(events, ["defer", "edit"]);
  return message;
}

test("/book-list starts with the ten newest books and shows the total library size", async () => {
  documents.push({ ...books[0], guildId: "other-server" }, { ...books[0], documentType: "rating" });
  let reply;
  await execute({ guildId, async reply(message) { reply = message; } });
  const { embed, menu, buttons } = validateMessage(reply);
  assert.equal(embed.fields.length, 10);
  assert.equal(embed.fields[0].name, "📖  Book 27");
  assert.equal(embed.fields[9].name, "📖  Book 18");
  assert.match(embed.footer.text, /Page 1 of 3.*27 books/);
  assert.equal(menu.options.find((option) => option.default).value, "added-newest");
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].label, "1/3");
  assert.equal(buttons[1].disabled, true);
  assert.equal(buttons[2].disabled, false);
  assert.equal(buttons[2].custom_id, "book-list-page:added-newest:1");
});

for (const [sort, reversed] of [
  ["added-oldest", false],
  ["added-newest", true],
  ["title-az", false],
  ["title-za", true],
  ["author-az", true],
  ["author-za", false],
]) {
  test(`${sort} pagination reaches every book and preserves sorting in both directions`, async () => {
    const expectedBooks = reversed ? [...books].reverse() : books;
    let message = await buildBookListMessage(guildId, sort);
    const seen = [];
    for (let page = 0; page < 3; page++) {
      const { embed, menu, buttons } = validateMessage(message);
      seen.push(...embed.fields.map((field) => field.name));
      assert.equal(menu.options.find((option) => option.default).value, sort);
      assert.equal(buttons[1].label, `${page + 1}/3`);
      assert.equal(buttons[0].disabled, page === 0);
      assert.equal(buttons[2].disabled, page === 2);
      assert.ok(isBookListPageCustomId(buttons[2].custom_id));
      if (page < 2) {
        message = await updateMessage(handleBookListPage, { customId: buttons[2].custom_id });
      }
    }
    assert.deepEqual(seen, expectedBooks.map((book) => `📖  ${book.title}`));
    const previousId = validateMessage(message).buttons[0].custom_id;
    const previous = validateMessage(await updateMessage(handleBookListPage, { customId: previousId }));
    assert.equal(previous.buttons[1].label, "2/3");
    assert.deepEqual(previous.embed.fields.map((field) => field.name),
      expectedBooks.slice(10, 20).map((book) => `📖  ${book.title}`));
  });
}

for (const count of [1, 10, 11, 20, 21]) {
  test(`${count} books have the correct final page and navigation controls`, async () => {
    documents = books.slice(0, count);
    const totalPages = Math.ceil(count / 10);
    const { embed, buttons } = validateMessage(await buildBookListMessage(guildId, "added-oldest", totalPages - 1));
    assert.equal(embed.fields.length, count % 10 || 10);
    assert.match(embed.footer.text, new RegExp(`Page ${totalPages} of ${totalPages}.*${count} book`));
    if (totalPages === 1) {
      assert.equal(buttons, undefined);
    } else {
      assert.equal(buttons[0].disabled, false);
      assert.equal(buttons[2].disabled, true);
    }
  });
}

test("changing sort resets to page one and updates navigation to use the new sort", async () => {
  const { embed, buttons } = validateMessage(await updateMessage(handleBookListSort, { values: ["title-za"] }));
  assert.equal(embed.fields[0].name, "📖  Book 27");
  assert.match(embed.footer.text, /Page 1 of 3/);
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[2].custom_id, "book-list-page:title-za:1");
});

test("an old page button moves to the last available page after books are removed", async () => {
  const firstPage = validateMessage(await buildBookListMessage(guildId));
  const secondPage = validateMessage(await updateMessage(handleBookListPage, { customId: firstPage.buttons[2].custom_id }));
  documents = books.slice(0, 11);
  const { embed, buttons } = validateMessage(await updateMessage(handleBookListPage, { customId: secondPage.buttons[2].custom_id }));
  assert.equal(embed.fields.length, 1);
  assert.equal(embed.fields[0].name, "📖  Book 01");
  assert.match(embed.footer.text, /Page 2 of 2.*11 books/);
  assert.equal(buttons[2].disabled, true);
});

test("page requests outside the library stay within the available pages", async () => {
  const first = validateMessage(await buildBookListMessage(guildId, "added-oldest", -1));
  const last = validateMessage(await buildBookListMessage(guildId, "added-oldest", 100));
  assert.equal(first.buttons[1].label, "1/3");
  assert.equal(last.buttons[1].label, "3/3");
});

test("an empty library replies privately and old controls clear the message", async () => {
  documents = [];
  assert.equal(await buildBookListMessage(guildId), null);
  let reply;
  await execute({ guildId, async reply(message) { reply = message; } });
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(reply.content, /No books/);
  for (const [handler, interaction] of [
    [handleBookListPage, { customId: "book-list-page:added-oldest:1" }],
    [handleBookListSort, { values: ["title-az"] }],
  ]) {
    const message = await updateMessage(handler, interaction);
    assert.match(message.content, /No books/);
    assert.deepEqual(message.embeds, []);
    assert.deepEqual(message.components, []);
  }
});

test("malformed page buttons are rejected without querying the database", async () => {
  for (const customId of [
    "book-list-page:title-az",
    "book-list-page:title-az:",
    "book-list-page:unknown:1",
    "book-list-page:constructor:1",
    "book-list-page:title-az:1.5",
    "book-list-page:title-az:NaN",
    "book-list-page:title-az:9007199254740992",
    "book-list-page:title-az:1:extra",
  ]) {
    let reply;
    await handleBookListPage({ guildId, customId, async reply(message) { reply = message; } });
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    assert.match(reply.content, /invalid/);
  }
  assert.equal(databaseReads, 0);
});
