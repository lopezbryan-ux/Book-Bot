import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

// Exercise poll closure and Discord announcements without connecting to either service.
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/book-bot-test";
const {
  mongoClient,
  BOOK_BOT_COLLECTION_NAME,
  BOOK_NOMINATIONS_COLLECTION_NAME,
  BOOK_POLLS_COLLECTION_NAME,
} = await import("../dist/mongo.js");
const { closeActiveBookPolls } = await import("../dist/poll-closing.js");

const now = new Date("2026-10-04T20:00:00Z");
let poll;
let announcements;
let pollMessages;
let bookUpdates;
const session = { async withTransaction(callback) { return callback(); } };

const collections = {
  [BOOK_POLLS_COLLECTION_NAME]: {
    async findOne(query) {
      return query.status && poll.status !== query.status ? null : structuredClone(poll);
    },
    find(query) {
      assert.equal(query.status, "active");
      assert.equal(query.guildId, poll.guildId);
      return {
        sort() { return this; },
        async toArray() { return poll.status === "active" ? [structuredClone(poll)] : []; },
      };
    },
    async updateOne(query, update, options) {
      assert.equal(options.session, session);
      assert.equal(query.status, "active");
      assert.equal(query.pollId, poll.pollId);
      assert.equal(query.guildId, poll.guildId);
      Object.assign(poll, update.$set);
      return { matchedCount: 1 };
    },
  },
  [BOOK_BOT_COLLECTION_NAME]: {
    async updateOne(query, update, options) {
      assert.equal(options.session, session);
      bookUpdates.push({ query, update });
      return { matchedCount: 1 };
    },
  },
  [BOOK_NOMINATIONS_COLLECTION_NAME]: {
    async updateOne(query, update, options) {
      assert.equal(options.session, session);
      return { matchedCount: 1 };
    },
    async deleteMany(query, options) {
      assert.equal(options.session, session);
      assert.deepEqual(query.nominationId.$in, poll.options.map((option) => option.nominationId));
      return { deletedCount: poll.options.length };
    },
  },
};

function serializeMessage(message) {
  return {
    ...message,
    embeds: message.embeds.map((embed) => embed.toJSON()),
    components: message.components?.map((row) => row.toJSON()),
  };
}

const channel = {
  isTextBased: () => true,
  messages: {
    async fetch(messageId) {
      assert.equal(messageId, poll.messageId);
      return {
        async edit(message) { pollMessages.push(serializeMessage(message)); },
      };
    },
  },
  async send(message) { announcements.push(serializeMessage(message)); },
};

const client = {
  channels: {
    async fetch(channelId) {
      assert.equal(channelId, poll.channelId);
      return channel;
    },
  },
};

const originalDb = mongoClient.db;
const originalWithSession = mongoClient.withSession;
before(() => {
  mongoClient.db = () => ({ collection: (name) => collections[name] });
  mongoClient.withSession = (callback) => callback(session);
});
beforeEach(() => {
  poll = {
    pollId: "announcement-test",
    documentType: "poll",
    guildId: "test-guild",
    channelId: "test-channel",
    messageId: "test-message",
    status: "active",
    pollType: "ranked",
    options: ["Book A", "Book B", "Book C"].map((title, index) => ({
      nominationId: `nomination-${index}`,
      title,
      normalizedTitle: title.toLowerCase(),
      author: null,
      nominatedBy: `nominator-${index}`,
      reason: null,
      imageUrl: null,
    })),
    votes: {},
    createdBy: "poll-creator",
    createdByUsername: "Poll Creator",
    winner: null,
    createdAt: new Date("2026-10-04T18:00:00Z"),
    updatedAt: new Date("2026-10-04T18:00:00Z"),
    closesAt: now,
    closedAt: null,
  };
  announcements = [];
  pollMessages = [];
  bookUpdates = [];
});
after(async () => {
  mongoClient.db = originalDb;
  mongoClient.withSession = originalWithSession;
  await mongoClient.close();
});

async function closePoll() {
  const votesBeforeClosing = structuredClone(poll.votes);
  const result = await closeActiveBookPolls({ client, guildId: poll.guildId, addWinners: true, now });
  assert.equal(result.closedCount, 1);
  assert.equal(poll.status, "closed");
  assert.deepEqual(poll.votes, votesBeforeClosing, "Closing must preserve the saved ballots");
  assert.equal(pollMessages.length, 1);
  return result;
}

function field(embed, name) {
  return embed.fields.find((field) => field.name === name)?.value;
}

function invalidRankedVotes() {
  return {
    partial: { first: 1, second: 2 },
    missingFirst: { second: 0, third: 1 },
    duplicate: { first: 1, second: 1, third: 2 },
    outOfRange: { first: 0, second: 1, third: 3 },
    negative: { first: -1, second: 1, third: 2 },
    wrongChoiceType: { first: 0, second: 1, third: "2" },
    fractionalFirst: { first: 0.5, second: 1, third: 2 },
    fractionalSecond: { first: 0, second: 1.5, third: 2 },
    fractionalThird: { first: 0, second: 1, third: 2.5 },
    nanChoice: { first: 0, second: NaN, third: 2 },
    infiniteChoice: { first: 0, second: 1, third: Infinity },
    empty: {},
    regularVote: 1,
    text: "1",
    nullVote: null,
    arrayVote: [0, 1, 2],
  };
}

test("the ranked winner announcement reveals only complete, distinct ballots that were scored", async () => {
  poll.votes = { valid: { first: 0, second: 1, third: 2 }, ...invalidRankedVotes() };
  await closePoll();

  assert.equal(poll.winner.title, "Book A");
  assert.equal(bookUpdates.length, 1);
  assert.equal(announcements.length, 1);
  const announcement = announcements[0].embeds[0];
  assert.equal(announcement.title, "Book Club Poll Winner");
  assert.equal(field(announcement, "Final score"), "3 points");
  assert.equal(
    field(announcement, "Votes"),
    "- <@valid>: #1 **Book A** (3 points), #2 **Book B** (2 points), #3 **Book C** (1 point)",
  );

  const closedEmbed = pollMessages[0].embeds[0];
  assert.equal(field(closedEmbed, "👥  Participation"), "1 complete ballot");
  assert.match(closedEmbed.description, /Book A\*\*\n⭐ 3 points/);
  assert.match(closedEmbed.description, /Book B\*\*\n⭐ 2 points/);
  assert.match(closedEmbed.description, /Book C\*\*\n⭐ 1 point/);
});

for (const pollType of ["regular", undefined]) {
  test(`the ${pollType ?? "legacy regular"} winner announcement omits malformed and ranked votes`, async () => {
    poll.pollType = pollType;
    poll.votes = {
      validA: 0,
      validB: 0,
      validC: 2,
      negative: -1,
      outOfRange: 3,
      fractional: 0.5,
      text: "1",
      ranked: { first: 1, second: 2, third: 0 },
      partial: { first: 0 },
      nullVote: null,
      arrayVote: [0, 1, 2],
    };
    await closePoll();

    assert.equal(poll.winner.title, "Book A");
    assert.equal(announcements.length, 1);
    const announcement = announcements[0].embeds[0];
    assert.equal(field(announcement, "Final score"), "2 votes");
    assert.equal(
      field(announcement, "Votes"),
      [
        "- <@validA> voted for **Book A**: 1 point",
        "- <@validB> voted for **Book A**: 1 point",
        "- <@validC> voted for **Book C**: 1 point",
      ].join("\n"),
    );
    assert.equal(field(pollMessages[0].embeds[0], "👥  Participation"), "3 votes cast");
  });
}

test("a ranked tie lists only voters whose complete ballots contributed to the tie", async () => {
  poll.votes = {
    validA: { first: 0, second: 1, third: 2 },
    validB: { first: 1, second: 0, third: 2 },
    ...invalidRankedVotes(),
  };
  await closePoll();

  assert.equal(poll.winner, null);
  assert.equal(bookUpdates.length, 0);
  assert.equal(announcements.length, 1);
  const announcement = announcements[0].embeds[0];
  assert.equal(announcement.title, "Book Club Poll Tie");
  assert.equal(
    announcement.description,
    "**Book A** - 5 points\nVoters: <@validA> (#1, 3 points), <@validB> (#2, 2 points)\n\n" +
      "**Book B** - 5 points\nVoters: <@validA> (#2, 2 points), <@validB> (#1, 3 points)",
  );
  assert.equal(field(pollMessages[0].embeds[0], "👥  Participation"), "2 complete ballots");
});

test("invalid ranked ballots alone produce no winner or credited voter announcement", async () => {
  poll.votes = invalidRankedVotes();
  await closePoll();

  assert.equal(poll.winner, null);
  assert.equal(bookUpdates.length, 0);
  assert.equal(announcements.length, 0);
  const closedEmbed = pollMessages[0].embeds[0];
  assert.equal(field(closedEmbed, "👥  Participation"), "0 complete ballots");
  assert.doesNotMatch(closedEmbed.description, /<@/);
});

test("a ballot corrected before closing is revealed and scored normally", async () => {
  poll.votes = invalidRankedVotes();
  poll.votes.partial = { first: 1, second: 2, third: 0 };
  await closePoll();

  assert.equal(poll.winner.title, "Book B");
  assert.equal(field(announcements[0].embeds[0], "Final score"), "3 points");
  assert.equal(
    field(announcements[0].embeds[0], "Votes"),
    "- <@partial>: #1 **Book B** (3 points), #2 **Book C** (2 points), #3 **Book A** (1 point)",
  );
});
