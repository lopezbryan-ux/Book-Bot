import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

const clone = (value) => structuredClone(value);
const get = (document, path) => path.split(".").reduce((value, key) => value?.[key], document);

function set(document, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((value, key) => value[key] ??= {}, document);
  parent[last] = clone(value);
}

function evaluate(expression, document, now) {
  if (expression === "$$NOW") return now;
  if (typeof expression === "string" && expression.startsWith("$")) return get(document, expression.slice(1));
  if (!expression || typeof expression !== "object" || expression instanceof Date) return expression;
  if (Array.isArray(expression)) return expression.map((value) => evaluate(value, document, now));
  const [operator, argument] = Object.entries(expression)[0];
  const values = evaluate(argument, document, now);
  switch (operator) {
    case "$or": return values.some(Boolean);
    case "$and": return values.every(Boolean);
    case "$eq": return isDeepStrictEqual(values[0], values[1]);
    case "$gt": return values[0] > values[1];
    case "$ifNull": return values[0] ?? values[1];
    case "$type": return values instanceof Date ? "date" : values === undefined ? "missing" : typeof values;
    default: throw new Error(`Unsupported test expression: ${operator}`);
  }
}

function matches(document, query, now) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$expr") return evaluate(condition, document, now);
    const value = get(document, key);
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      if ("$exists" in condition) return (value !== undefined) === condition.$exists;
      if ("$ne" in condition) return !isDeepStrictEqual(value, condition.$ne);
      if ("$in" in condition) return condition.$in.some((item) => isDeepStrictEqual(value, item));
      if ("$lte" in condition) return value <= condition.$lte;
    }
    return isDeepStrictEqual(value, condition);
  });
}

class WriteConflict extends Error {}

// Model snapshots and commit conflicts so application callbacks must retry with
// fresh data. Hooks insert another actor's write at a specific race boundary.
export class PollStore {
  constructor(poll) {
    this.state = {
      poll: clone(poll),
      nominations: poll.options.map((option) => ({
        ...clone(option), documentType: "nomination", guildId: poll.guildId, channelId: poll.channelId,
        status: "nominated", nominatedByUsername: option.nominatedBy,
        createdAt: poll.createdAt, updatedAt: poll.updatedAt,
      })),
      books: [],
    };
    this.version = 0;
    this.serverNow = new Date();
    this.nextPollWrite = null;
    this.nextNominationDelete = null;
    this.transactionAttempts = 0;
    this.voteWrites = 0;
    this.transactions = new AsyncLocalStorage();
  }

  mutate(action) {
    action(this.state);
    this.version += 1;
  }

  async withSession(callback) {
    const session = {
      withTransaction: async (action, options) => {
        assert.equal(options.readConcern.level, "snapshot");
        assert.equal(options.writeConcern.w, "majority");
        for (let attempt = 0; attempt < 10; attempt += 1) {
          this.transactionAttempts += 1;
          session.state = clone(this.state);
          session.version = this.version;
          session.wrote = false;
          try {
            const result = await this.transactions.run(session, action);
            if (session.wrote) {
              if (this.version !== session.version) throw new WriteConflict();
              this.state = session.state;
              this.version += 1;
            }
            return result;
          } catch (error) {
            if (!(error instanceof WriteConflict)) throw error;
          }
        }
        throw new Error("Too many test transaction retries");
      },
    };
    return callback(session);
  }

  collection(name) {
    const kind = name === "BookBotPolls" ? "poll" : name === "BookBotNominations" ? "nominations" : "books";
    const state = (options) => options?.session?.state ?? this.state;
    const documents = (options) => kind === "poll" ? [state(options).poll] : state(options)[kind];
    const write = async (options) => {
      if (kind === "poll" && this.nextPollWrite) {
        const hook = this.nextPollWrite;
        this.nextPollWrite = null;
        await hook();
      }
      if (options?.session) {
        if (this.version !== options.session.version) throw new WriteConflict();
        options.session.wrote = true;
      } else this.version += 1;
    };
    const updateOne = async (query, update, options = {}) => {
      await write(options);
      let document = documents(options).find((document) => matches(document, query, this.serverNow));
      const inserted = !document && options.upsert;
      if (inserted) {
        document = { ...clone(query), ...clone(update.$setOnInsert ?? {}) };
        state(options)[kind].push(document);
      }
      if (!document) return { matchedCount: 0, upsertedCount: 0 };
      for (const [key, value] of Object.entries(update.$set ?? {})) set(document, key, value);
      if (kind === "poll" && !options.session) this.voteWrites += 1;
      return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
    };

    return {
      find: (query, options) => {
        const result = clone(documents(options).filter((document) => matches(document, query, this.serverNow)));
        return { sort() { return this; }, async toArray() { return result; } };
      },
      findOne: async (query, options) => clone(documents(options).find((document) => matches(document, query, this.serverNow)) ?? null),
      updateOne,
      findOneAndUpdate: async (query, update, options) => {
        assert.equal(options.returnDocument, "after");
        const result = await updateOne(query, update, options);
        return result.matchedCount ? clone(state(options).poll) : null;
      },
      deleteMany: async (query, options) => {
        if (kind === "nominations" && this.nextNominationDelete) {
          const hook = this.nextNominationDelete;
          this.nextNominationDelete = null;
          await hook();
        }
        await write(options);
        const before = documents(options);
        const after = before.filter((document) => !matches(document, query, this.serverNow));
        state(options)[kind] = after;
        return { deletedCount: before.length - after.length };
      },
      deleteOne: async (query, options) => {
        await write(options);
        const index = documents(options).findIndex((document) => matches(document, query, this.serverNow));
        if (index < 0) return { deletedCount: 0 };
        state(options)[kind].splice(index, 1);
        return { deletedCount: 1 };
      },
    };
  }
}

export function pollFixture(pollType = "regular") {
  const now = new Date();
  return {
    pollId: "20000000-0000-4000-8000-000000000001",
    documentType: "poll", guildId: "flow-guild", channelId: "flow-channel", messageId: "flow-message",
    status: "active", pollType,
    options: ["Book A", "Book B", "Book C"].map((title, index) => ({
      nominationId: `10000000-0000-4000-8000-00000000000${index + 1}`,
      title, normalizedTitle: title.toLowerCase(), author: `Author ${index + 1}`,
      nominatedBy: `nominator-${index}`, reason: null, imageUrl: null,
    })),
    votes: {}, createdBy: "creator", createdByUsername: "Creator", winner: null,
    createdAt: now, updatedAt: now, closesAt: new Date(now.getTime() + 60_000), closedAt: null,
  };
}
