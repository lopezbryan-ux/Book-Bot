import { type Filter } from "mongodb";
import { type PollDocument } from "./book-club.js";

export function isPollOpen(poll: Pick<PollDocument, "status" | "closesAt">, now = new Date()) {
  return poll.status === "active" && (
    poll.closesAt == null || (poll.closesAt instanceof Date && poll.closesAt.getTime() > now.getTime())
  );
}

export function openPollFilter(pollId: string, guildId: string | null): Filter<PollDocument> {
  return {
    pollId,
    guildId,
    status: "active",
    // Check the deadline at the database, rather than at an earlier application read.
    $expr: {
      $or: [
        { $eq: [{ $ifNull: ["$closesAt", null] }, null] },
        { $and: [{ $eq: [{ $type: "$closesAt" }, "date"] }, { $gt: ["$closesAt", "$$NOW"] }] },
      ],
    },
  };
}

export class PollClosedError extends Error {
  constructor() {
    super("Voting has ended for this poll.");
  }
}
