import { PollVotes, RankedPollVote } from "./book-club.js";

function isRankedPollVote(value: unknown): value is RankedPollVote {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapRegularVote(vote: number, indexMap: Map<number, number>) {
  return indexMap.get(vote);
}

function remapRankedVote(vote: RankedPollVote, indexMap: Map<number, number>) {
  const remappedVote: RankedPollVote = {};

  for (const rankKey of ["first", "second", "third"] as const) {
    const choice = vote[rankKey];
    if (typeof choice !== "number") continue;

    const remappedChoice = indexMap.get(choice);
    if (typeof remappedChoice === "number") {
      remappedVote[rankKey] = remappedChoice;
    }
  }

  return remappedVote;
}

export function remapPollVotes(votes: PollVotes, indexMap: Map<number, number>) {
  const remappedVotes: PollVotes = {};

  for (const [userId, vote] of Object.entries(votes ?? {})) {
    if (typeof vote === "number") {
      const remappedVote = remapRegularVote(vote, indexMap);
      if (typeof remappedVote === "number") {
        remappedVotes[userId] = remappedVote;
      }
      continue;
    }

    if (isRankedPollVote(vote)) {
      remappedVotes[userId] = remapRankedVote(vote, indexMap);
    }
  }

  return remappedVotes;
}
