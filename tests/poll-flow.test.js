import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PollStore, pollFixture } from "./helpers/poll-store.js";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/book-bot-test";
const { mongoClient } = await import("../dist/mongo.js");
const {
  buildPollComponents, buildPollCustomId, buildPollRankCustomId, buildPollRankOpenCustomId,
  getPollScores, handleBookPollVote, handleBookPollRank, handleBookPollRankOpen, refreshPollMessage,
} = await import("../dist/polls.js");
const { closeActiveBookPolls } = await import("../dist/poll-closing.js");
const nominate = await import("../dist/commands/nominate-book.js");
const remove = await import("../dist/commands/remove-nomination.js");
const { remapPollVotes } = await import("../dist/poll-votes.js");

let store;
let client;
let edits;
let announcements;
let beforeEdit;
const originalDb = mongoClient.db;
const originalWithSession = mongoClient.withSession;
const serialize = (message) => typeof message === "string" ? { content: message } : {
  ...message,
  embeds: message.embeds?.map((embed) => embed.toJSON()),
  components: message.components?.map((row) => row.toJSON()),
};

before(() => {
  mongoClient.db = () => ({ collection: (name) => store.collection(name) });
  mongoClient.withSession = (callback) => store.withSession(callback);
});
beforeEach(() => {
  store = new PollStore(pollFixture());
  edits = [];
  announcements = [];
  beforeEdit = null;
  const channel = {
    isTextBased: () => true,
    messages: {
      async fetch() {
        return {
          async edit(message) {
            assert.equal(store.transactions.getStore(), undefined, "Discord edits must follow commit");
            const serialized = serialize(message);
            if (beforeEdit) await beforeEdit(serialized);
            edits.push(serialized);
          },
        };
      },
    },
    async send(message) {
      assert.equal(store.transactions.getStore(), undefined, "Announcements must follow commit");
      announcements.push(serialize(message));
    },
  };
  client = { channels: { async fetch() { return channel; } } };
});
after(async () => {
  mongoClient.db = originalDb;
  mongoClient.withSession = originalWithSession;
  await mongoClient.close();
});

function interaction({ userId = "voter", customId, values = [], strings = {}, ephemeral = false, guildId = "flow-guild" } = {}) {
  return {
    client, guildId, channelId: "flow-channel", user: { id: userId, username: userId }, customId, values,
    options: { getString: (name) => strings[name] ?? null, getFocused: () => "" },
    message: { flags: { has: () => ephemeral } },
    async deferReply() { this.deferred = true; },
    async deferUpdate() { this.deferred = true; },
    async reply(message) { this.response = serialize(message); },
    async update(message) { this.response = serialize(message); },
    async editReply(message) { assert.equal(this.deferred, true); this.response = serialize(message); },
    async respond(choices) { this.choices = choices; },
  };
}

const poll = () => store.state.poll;
const optionId = (index) => poll().options[index].nominationId;
const controls = (message) => message.components.flatMap((row) => row.components);
const close = () => closeActiveBookPolls({ client, guildId: poll().guildId, addWinners: true });

async function vote(nominationId, rankIndex, userId = "voter") {
  const request = interaction({
    userId,
    customId: rankIndex === undefined ? buildPollCustomId(poll().pollId, nominationId, 0) : buildPollRankCustomId(poll().pollId, rankIndex, 0),
    values: rankIndex === undefined ? [] : [nominationId],
    ephemeral: rankIndex !== undefined,
  });
  await (rankIndex === undefined ? handleBookPollVote : handleBookPollRank)(request);
  return request.response;
}

test("regular buttons and ranked menu values identify nominations by stable IDs", () => {
  const regular = buildPollComponents(poll()).map((row) => row.toJSON());
  regular[0].components.forEach((button, index) => {
    assert.ok(button.custom_id.includes(optionId(index)));
    assert.ok(button.custom_id.length <= 100);
  });
  poll().pollType = "ranked";
  const ranked = buildPollComponents(poll(), false, 0, "voter").map((row) => row.toJSON());
  for (const row of ranked) assert.deepEqual(row.components[0].options.map((option) => option.value), poll().options.map((option) => option.nominationId));
});

test("later pages keep stable IDs and Discord's component length limits", async () => {
  const template = poll().options[0];
  poll().options = Array.from({ length: 25 }, (_, index) => ({
    ...template,
    nominationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    title: `Book ${index + 1}`,
  }));
  const rows = buildPollComponents(poll(), false, 1).map((row) => row.toJSON());
  assert.equal(rows[0].components[4].custom_id, buildPollCustomId(poll().pollId, optionId(24), 1));
  rows.flatMap((row) => row.components).forEach((component) => assert.ok(component.custom_id.length <= 100));
  await vote(optionId(24));
  assert.equal(poll().votes.voter, 24);
  poll().pollType = "ranked";
  const ranked = buildPollComponents(poll(), false, 1, "voter").map((row) => row.toJSON());
  assert.equal(ranked[0].components[0].options[4].value, optionId(24));
});

for (const pollType of ["regular", "ranked"]) {
  const rank = pollType === "ranked" ? 0 : undefined;

  test(`${pollType}: old positional controls are rejected and refreshed`, async () => {
    poll().pollType = pollType;
    const response = await vote("1", rank);
    assert.match(response.content, /out of date/);
    assert.deepEqual(poll().votes, {});
    assert.equal(store.voteWrites, 0);
    assert.ok(edits.length > 0);
    if (pollType === "ranked") assert.equal(controls(response)[0].options[0].value, optionId(0));
  });

  test(`${pollType}: a stale control still selects the same book after another nomination is removed`, async () => {
    poll().pollType = pollType;
    const bookB = optionId(1);
    await remove.execute(interaction({ userId: "nominator-0", strings: { nomination: optionId(0) } }));
    const response = await vote(bookB, rank);
    assert.match(response.content, /Book B/);
    assert.deepEqual(poll().votes.voter, rank === undefined ? 0 : { first: 0 });
  });

  test(`${pollType}: a removed book's control cannot silently select its replacement position`, async () => {
    poll().pollType = pollType;
    const removedId = optionId(0);
    await remove.execute(interaction({ userId: "nominator-0", strings: { nomination: removedId } }));
    const response = await vote(removedId, rank);
    assert.match(response.content, /no longer available/);
    assert.deepEqual(poll().votes, {});
  });

  test(`${pollType}: expired polls reject votes while their stored status is still active`, async () => {
    poll().pollType = pollType;
    poll().closesAt = new Date(Date.now() - 1);
    const response = await vote(optionId(0), rank);
    assert.match(response.content, /Voting has ended/);
    assert.equal(poll().status, "active");
    assert.equal(store.voteWrites, 0);
    assert.deepEqual(poll().votes, {});
  });

  test(`${pollType}: the database deadline prevents a vote when time expires during saving`, async () => {
    poll().pollType = pollType;
    store.nextPollWrite = () => { store.serverNow = new Date(poll().closesAt.getTime() + 1); };
    const response = await vote(optionId(0), rank);
    assert.doesNotMatch(response.content, /is counted|is complete/);
    assert.equal(store.voteWrites, 0);
    assert.deepEqual(poll().votes, {});
  });

  test(`${pollType}: closing between the read and write prevents the vote from being saved`, async () => {
    poll().pollType = pollType;
    store.nextPollWrite = () => store.mutate((state) => { state.poll.status = "closed"; });
    const response = await vote(optionId(0), rank);
    assert.match(response.content, /Voting has ended/);
    assert.deepEqual(poll().votes, {});
    assert.ok(controls(edits.at(-1)).every((component) => component.disabled));
  });
}

test("a nomination shift during a vote save retries using its ID and current position", async () => {
  const bookB = optionId(1);
  store.nextPollWrite = () => store.mutate((state) => {
    state.poll.options.shift();
    state.poll.votes = remapPollVotes(state.poll.votes, new Map([[1, 0], [2, 1]]));
  });
  await vote(bookB);
  assert.equal(poll().votes.voter, 0);
  assert.equal(poll().options[poll().votes.voter].title, "Book B");
});

test("simultaneous ranked choices preserve all three ranks for the same member", async () => {
  poll().pollType = "ranked";
  await Promise.all([0, 1, 2].map((rank) => vote(optionId(rank), rank)));
  assert.deepEqual(poll().votes.voter, { first: 0, second: 1, third: 2 });
  assert.deepEqual(getPollScores(poll()), [3, 2, 1]);
});

test("simultaneous regular votes preserve both members, and a revote replaces only its own vote", async () => {
  await Promise.all([vote(optionId(0), undefined, "voter-a"), vote(optionId(1), undefined, "voter-b")]);
  assert.deepEqual(getPollScores(poll()), [1, 1, 0]);
  await vote(optionId(2), undefined, "voter-a");
  assert.deepEqual(poll().votes, { "voter-a": 2, "voter-b": 1 });
  assert.deepEqual(getPollScores(poll()), [0, 1, 1]);
});

test("partial and duplicate ranked ballots explicitly warn they do not count until corrected", async () => {
  poll().pollType = "ranked";
  assert.match((await vote(optionId(0), 0)).content, /does not count yet/);
  await vote(optionId(0), 1);
  assert.match((await vote(optionId(2), 2)).content, /Pick three different books/);
  assert.deepEqual(getPollScores(poll()), [0, 0, 0]);
  assert.match((await vote(optionId(1), 1)).content, /ballot is complete/);
  assert.deepEqual(getPollScores(poll()), [3, 2, 1]);
});

test("expired polls cannot open another private ranked ballot", async () => {
  poll().pollType = "ranked";
  poll().closesAt = new Date(Date.now() - 1);
  const request = interaction({ customId: buildPollRankOpenCustomId(poll().pollId, 0) });
  await handleBookPollRankOpen(request);
  assert.match(request.response.content, /Voting has ended/);
});

test("removing a nomination retries with a concurrent accepted vote instead of losing it", async () => {
  store.nextPollWrite = () => store.mutate((state) => { state.poll.votes.lateVoter = 2; });
  await remove.execute(interaction({ userId: "nominator-0", strings: { nomination: optionId(0) } }));
  assert.ok(store.transactionAttempts >= 2);
  assert.equal(poll().options[poll().votes.lateVoter].title, "Book C");
  assert.deepEqual(poll().votes, { lateVoter: 1 });
  assert.equal(store.state.nominations.length, 2);
});

test("replacing a nominated book clears its old votes and invalidates its old controls", async () => {
  const oldId = optionId(0);
  poll().votes = { oldBook: 0, otherBook: 1, ranked: { first: 0, second: 1, third: 2 } };
  const request = interaction({ userId: "nominator-0", strings: { title: "Replacement", author: "Replacement Author" } });
  await nominate.execute(request);

  assert.notEqual(optionId(0), oldId);
  assert.equal(poll().options[0].title, "Replacement");
  assert.deepEqual(poll().votes, { otherBook: 1, ranked: { second: 1, third: 2 } });
  assert.match(request.response.content, /previous book were cleared/);
  assert.match((await vote(oldId)).content, /no longer available/);
  assert.equal(store.state.nominations.length, 3);
});

test("updating a nomination's reason and cover preserves the same ID and existing votes", async () => {
  const oldId = optionId(0);
  poll().votes = { voter: 0 };
  await nominate.execute(interaction({ userId: "nominator-0", strings: {
    title: "Book A", author: "Author 1", reason: "A new reason", "image-url": "https://example.com/cover.jpg",
  } }));
  assert.equal(optionId(0), oldId);
  assert.deepEqual(poll().votes, { voter: 0 });
  assert.equal(poll().options[0].reason, "A new reason");
  assert.equal(poll().options[0].imageUrl, "https://example.com/cover.jpg");
});

test("nomination edits and removals after the deadline leave both collections unchanged", async () => {
  poll().closesAt = new Date(Date.now() - 1);
  const before = structuredClone(store.state);
  const edit = interaction({ userId: "nominator-0", strings: { title: "Replacement", author: "Author" } });
  const removal = interaction({ userId: "nominator-0", strings: { nomination: optionId(0) } });
  await nominate.execute(edit);
  await remove.execute(removal);
  assert.match(edit.response.content, /no open book poll/);
  assert.match(removal.response.content, /no open book poll/);
  assert.deepEqual(store.state, before);
});

test("a deadline reached midway through a nomination transaction rolls back the nomination edit", async () => {
  const before = structuredClone(store.state);
  store.nextPollWrite = () => { store.serverNow = new Date(poll().closesAt.getTime() + 1); };
  const request = interaction({ userId: "nominator-0", strings: { title: "Replacement", author: "Author" } });
  await nominate.execute(request);
  assert.match(request.response.content, /Voting has ended/);
  assert.deepEqual(store.state, before);
  assert.equal(edits.length, 0);
});

test("members cannot remove another member's nomination", async () => {
  const before = structuredClone(store.state);
  const request = interaction({ userId: "other-member", strings: { nomination: optionId(0) } });
  await remove.execute(request);
  assert.match(request.response.content, /not yours/);
  assert.deepEqual(store.state, before);
});

test("closing retries after a concurrent vote and uses the same final snapshot for winner and results", async () => {
  poll().votes = { firstVoter: 0 };
  store.nextPollWrite = () => store.mutate((state) => { state.poll.votes = { firstVoter: 1, secondVoter: 1 }; });
  const result = await close();
  assert.ok(store.transactionAttempts >= 2);
  assert.equal(result.closedCount, 1);
  assert.equal(poll().winner.title, "Book B");
  assert.deepEqual(getPollScores(poll()), [0, 2, 0]);
  assert.equal(store.state.books.length, 1);
  assert.equal(store.state.books[0].title, "Book B");
  assert.equal(announcements.length, 1);
  const announcement = announcements[0].embeds[0];
  assert.equal(announcement.fields.find((field) => field.name === "Final score").value, "2 votes");
  assert.match(announcement.fields.find((field) => field.name === "Votes").value, /firstVoter.*Book B/);
  assert.ok(controls(edits.at(-1)).every((component) => component.disabled));
});

test("two overlapping closers produce one committed winner and one announcement", async () => {
  poll().votes = { voter: 0 };
  const results = await Promise.all([close(), close()]);
  assert.equal(results.reduce((total, result) => total + result.closedCount, 0), 1);
  assert.equal(results.reduce((total, result) => total + result.clearedNominationCount, 0), 3);
  assert.equal(announcements.length, 1);
  assert.equal(store.state.books.length, 1);
  assert.equal(store.state.nominations.length, 0);
});

test("a failure clearing nominations rolls back closure and book creation before Discord side effects", async () => {
  poll().votes = { voter: 0 };
  const before = structuredClone(store.state);
  store.nextNominationDelete = () => { throw new Error("simulated database failure"); };
  await assert.rejects(close(), /simulated database failure/);
  assert.deepEqual(store.state, before);
  assert.equal(announcements.length, 0);
  assert.equal(edits.length, 0);
});

test("queued public updates cannot leave a closed poll with voting controls re-enabled", async () => {
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let firstEdit = true;
  beforeEdit = async () => {
    if (!firstEdit) return;
    firstEdit = false;
    entered();
    await blocked;
  };
  const staleRefresh = refreshPollMessage(client, structuredClone(poll()));
  await started;
  poll().votes = { voter: 0 };
  const closing = close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(poll().status, "closed");
  release();
  await Promise.all([staleRefresh, closing]);
  assert.equal(edits.at(-1).embeds[0].title, "📕  Book Poll Closed");
  assert.ok(controls(edits.at(-1)).every((component) => component.disabled));
});

test("a poll ID from another server cannot accept a vote", async () => {
  const request = interaction({ guildId: "other-server", customId: buildPollCustomId(poll().pollId, optionId(0), 0) });
  await handleBookPollVote(request);
  assert.match(request.response.content, /Voting has ended/);
  assert.deepEqual(poll().votes, {});
});
