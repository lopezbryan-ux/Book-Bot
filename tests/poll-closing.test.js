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
  assertAnnouncementLimits();
  return result;
}

function assertAnnouncementLimits() {
  for (const message of announcements) {
    assert.ok((message.content?.length ?? 0) <= 2000);
    let totalLength = 0;
    for (const embed of message.embeds) {
      assert.ok((embed.title?.length ?? 0) <= 256);
      assert.ok((embed.description?.length ?? 0) <= 4096);
      assert.ok((embed.fields?.length ?? 0) <= 25);
      totalLength += (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
        + (embed.footer?.text.length ?? 0) + (embed.author?.name.length ?? 0);
      for (const field of embed.fields ?? []) {
        assert.ok(field.name.length <= 256);
        assert.ok(field.value.trim().length > 0 && field.value.length <= 1024);
        totalLength += field.name.length + field.value.length;
      }
    }
    assert.ok(totalLength <= 6000, `Announcement exceeded Discord's embed budget: ${totalLength}`);
  }
}

function revealedVotes() {
  return announcements.flatMap((message) => {
    const ballotFiles = message.files?.filter((file) => file.name === "book-poll-ballot.txt") ?? [];
    if (ballotFiles.length > 0) return ballotFiles.map((file) => file.attachment.toString("utf8"));
    return message.embeds.flatMap((embed) => {
      const voteField = field(embed, "Votes");
      if (voteField) return [voteField];
      const marker = "**Votes**\n";
      const markerIndex = embed.description?.indexOf(marker) ?? -1;
      return markerIndex >= 0 ? [embed.description.slice(markerIndex + marker.length)] : [];
    });
  });
}

function assertSingleEveryoneMention() {
  assert.equal(announcements.filter((message) => message.content?.includes("@everyone")).length, 1);
  assert.deepEqual(announcements[0].allowedMentions.parse, ["everyone"]);
  for (const message of announcements.slice(1)) {
    assert.equal(message.content, undefined);
    assert.deepEqual(message.allowedMentions, { parse: [] });
  }
}

function field(embed, name) {
  return embed.fields?.find((field) => field.name === name)?.value;
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
  assert.equal(field(announcement, "Runner-up"), "**Book B** - 2 points");
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
    assert.equal(field(announcement, "Runner-up"), "**Book C** - 1 vote");
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

test("the ranked runner-up is chosen by points and includes the author", async () => {
  poll.options[2].author = "Author C";
  poll.votes = { valid: { first: 0, second: 2, third: 1 }, ...invalidRankedVotes() };
  await closePoll();

  const announcement = announcements[0].embeds[0];
  assert.equal(field(announcement, "Runner-up"), "**Book C by Author C** - 2 points");
  assert.equal(bookUpdates.length, 1);
  assert.equal(bookUpdates[0].update.$set.title, "Book A");
  assert.equal(poll.winner.title, "Book A");
});

test("books tied for second place are all announced as runners-up", async () => {
  poll.votes = {
    first: { first: 0, second: 1, third: 2 },
    second: { first: 0, second: 2, third: 1 },
  };
  await closePoll();

  const announcement = announcements[0].embeds[0];
  assert.equal(field(announcement, "Final score"), "6 points");
  assert.equal(field(announcement, "Runners-up (tied)"), "**Book B** - 3 points\n**Book C** - 3 points");
  assert.equal(field(announcement, "Runner-up"), undefined);
  assert.equal(bookUpdates.length, 1);
  assertSingleEveryoneMention();
});

test("regular polls show the other nominees tied at zero votes when all votes go to the winner", async () => {
  poll.pollType = "regular";
  poll.votes = { first: 0, second: 0 };
  await closePoll();

  assert.equal(
    field(announcements[0].embeds[0], "Runners-up (tied)"),
    "**Book B** - 0 votes\n**Book C** - 0 votes",
  );
});

test("a poll with one nominee explains why there is no runner-up", async () => {
  poll.pollType = "regular";
  poll.options = poll.options.slice(0, 1);
  poll.votes = { member: 0 };
  await closePoll();

  assert.equal(field(announcements[0].embeds[0], "Runner-up"), "No other books were nominated.");
  assert.equal(field(announcements[0].embeds[0], "Final score"), "1 vote");
});

test("a long list of tied runners-up preserves all full titles and scores", async () => {
  const optionTemplate = poll.options[1];
  const otherOptions = Array.from({ length: 8 }, (_, index) => ({
    ...optionTemplate,
    nominationId: `runner-${index}`,
    title: `Runner ${index} ${"long title ".repeat(10)}`.trim(),
    author: `Author ${index} ${"name ".repeat(6)}`.trim(),
  }));
  poll.options = [poll.options[0], ...otherOptions];
  poll.votes = {};
  for (let index = 1; index < poll.options.length; index += 2) {
    poll.votes[`first-${index}`] = { first: 0, second: index, third: index + 1 };
    poll.votes[`second-${index}`] = { first: 0, second: index + 1, third: index };
  }
  await closePoll();

  const expected = otherOptions.map((option) => `**${option.title} by ${option.author}** - 3 points`).join("\n");
  assert.ok(expected.length > 1024);
  const announcement = announcements[0].embeds[0];
  assert.ok(announcement.description.endsWith(`**Runners-up (tied)**\n${expected}`));
  assert.equal(field(announcement, "Final score"), "24 points");
  assert.equal(bookUpdates.length, 1);
  assertSingleEveryoneMention();
});

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
  assert.equal(field(announcement, "Runner-up"), undefined);
  assert.equal(field(announcement, "Runners-up (tied)"), undefined);
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

test("twenty ranked voters are revealed in five messages of four complete ballots", async () => {
  const members = Array.from({ length: 20 }, (_, index) => `member-${index}`);
  poll.votes = Object.fromEntries(members.map((member) => [member, { first: 0, second: 1, third: 2 }]));
  await closePoll();

  const expected = members.map((member) =>
    `- <@${member}>: #1 **Book A** (3 points), #2 **Book B** (2 points), #3 **Book C** (1 point)`,
  ).join("\n");
  assert.ok(expected.length > 1024);
  assert.equal(announcements.length, 5);
  assert.equal(revealedVotes().length, 5);
  assert.equal(revealedVotes().join("\n"), expected);
  for (const chunk of revealedVotes()) {
    assert.equal(chunk.split("\n").length, 4);
    assert.ok(chunk.trim().startsWith("- <@"));
    assert.ok(chunk.trim().endsWith("#3 **Book C** (1 point)"), "Keep a member's ballot together");
  }
  assert.equal(field(announcements[0].embeds[0], "Final score"), "60 points");
  assertSingleEveryoneMention();
});

test("long book names reduce the number of voters in a message without splitting any ballot", async () => {
  poll.options.forEach((option, index) => {
    option.title = `Book ${index} ${"long title ".repeat(10)}`.trim();
    option.author = "Long Author ".repeat(10).trim();
  });
  const members = Array.from({ length: 5 }, (_, index) => `member-${index}`);
  poll.votes = Object.fromEntries(members.map((member) => [member, { first: 0, second: 1, third: 2 }]));
  await closePoll();

  assert.equal(announcements.length, 5);
  const [first, second, third] = poll.options;
  for (const [index, page] of revealedVotes().entries()) {
    assert.equal(page, `- <@${members[index]}>: #1 **${first.title} by ${first.author}** (3 points), `
      + `#2 **${second.title} by ${second.author}** (2 points), `
      + `#3 **${third.title} by ${third.author}** (1 point)`);
    assert.ok(page.length <= 1024);
  }
  assertSingleEveryoneMention();
});

test("ranked winner announcements continue across messages without omitting votes or repeating mentions", async () => {
  const members = Array.from({ length: 150 }, (_, index) => `member-${index}`);
  poll.options[0].imageUrl = "https://example.com/cover.jpg";
  poll.votes = {
    ...Object.fromEntries(members.map((member) => [member, { first: 0, second: 1, third: 2 }])),
    ...invalidRankedVotes(),
  };
  await closePoll();

  const expected = members.map((member) =>
    `- <@${member}>: #1 **Book A** (3 points), #2 **Book B** (2 points), #3 **Book C** (1 point)`,
  ).join("\n");
  assert.ok(expected.length > 12000);
  assert.equal(announcements.length, 38);
  assert.equal(revealedVotes().join("\n"), expected);
  for (const page of revealedVotes()) assert.ok(page.split("\n").length <= 4);
  assert.equal(revealedVotes().at(-1).split("\n").length, 2);
  assert.equal(announcements[0].embeds[0].image.url, poll.options[0].imageUrl);
  assert.equal(field(announcements[0].embeds[0], "Final score"), "450 points");
  assert.equal(bookUpdates.length, 1);
  assertSingleEveryoneMention();
});

test("regular winner announcements also preserve vote lists that exceed a message's embed budget", async () => {
  poll.pollType = "regular";
  const members = Array.from({ length: 200 }, (_, index) => `member-${index}`);
  poll.votes = Object.fromEntries(members.map((member) => [member, 0]));
  await closePoll();

  assert.equal(announcements.length, 50);
  for (const page of revealedVotes()) assert.equal(page.split("\n").length, 4);
  assert.equal(revealedVotes().join("\n"), members.map((member) =>
    `- <@${member}> voted for **Book A**: 1 point`,
  ).join("\n"));
  assert.equal(field(announcements[0].embeds[0], "Final score"), "200 votes");
  assertSingleEveryoneMention();
});

test("a single oversized ranked ballot retains every rank and full book title", async () => {
  poll.options.forEach((option, index) => {
    option.title = `Book ${index} ${"📚".repeat(200)}`;
    option.author = "Author ".repeat(20).trim();
  });
  poll.votes = { member: { first: 0, second: 1, third: 2 } };
  await closePoll();

  const [first, second, third] = poll.options;
  const expected = `- <@member>: #1 **${first.title} by ${first.author}** (3 points), `
    + `#2 **${second.title} by ${second.author}** (2 points), `
    + `#3 **${third.title} by ${third.author}** (1 point)`;
  assert.ok(expected.length > 1024);
  assert.equal(announcements.length, 1);
  assert.equal(revealedVotes().join("\n"), expected);
  assert.match(announcements[0].embeds[0].description, /\*\*Votes\*\*\n- <@member>:/);
  for (const chunk of revealedVotes()) {
    assert.equal((chunk.match(/\*\*/g) ?? []).length % 2, 0, "Keep book title formatting intact");
  }
});

test("large ranked ties reveal all contributing voters across continuation messages", async () => {
  const firstMembers = Array.from({ length: 90 }, (_, index) => `first-${index}`);
  const secondMembers = Array.from({ length: 90 }, (_, index) => `second-${index}`);
  poll.votes = {
    ...Object.fromEntries(firstMembers.map((member) => [member, { first: 0, second: 1, third: 2 }])),
    ...Object.fromEntries(secondMembers.map((member) => [member, { first: 1, second: 0, third: 2 }])),
    ...invalidRankedVotes(),
  };
  await closePoll();

  const expectedA = firstMembers.map((member) => `<@${member}> (#1, 3 points)`)
    .concat(secondMembers.map((member) => `<@${member}> (#2, 2 points)`)).join(", ");
  const expectedB = firstMembers.map((member) => `<@${member}> (#2, 2 points)`)
    .concat(secondMembers.map((member) => `<@${member}> (#1, 3 points)`)).join(", ");
  const expected = `**Book A** - 450 points\nVoters: ${expectedA}\n\n**Book B** - 450 points\nVoters: ${expectedB}`;
  assert.ok(expected.length > 4096);
  assert.ok(announcements.length > 1);
  assert.equal(announcements.flatMap((message) => message.embeds).map((embed) => embed.description).join(""), expected);
  assert.equal(poll.winner, null);
  assert.equal(bookUpdates.length, 0);
  assertSingleEveryoneMention();
});
