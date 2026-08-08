import { OpenAI } from "openai";

const HF_MODEL = process.env.HF_MODEL || "deepseek-ai/DeepSeek-V4-Flash:novita";
const MAX_REVIEW_SNIPPETS = 5;
const MAX_REVIEW_LENGTH = 240;

const client = process.env.HF_TOKEN
  ? new OpenAI({
      baseURL: "https://router.huggingface.co/v1",
      apiKey: process.env.HF_TOKEN,
    })
  : null;

export interface BookSummaryRequest {
  key: string;
  title: string;
  author: string | null;
  averageRating: number;
  ratingCount: number;
  reviews: string[];
}

export interface BookAiSummary {
  ratingSummary: string;
}

interface BookSummaryResponseItem {
  key?: unknown;
  ratingSummary?: unknown;
}

function stripThinkBlocks(value: string) {
  return value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3).trimEnd()}...` : value;
}

function compactBooksForPrompt(books: BookSummaryRequest[]) {
  return books.map((book) => ({
    key: book.key,
    title: book.title,
    author: book.author,
    averageRating: Math.round(book.averageRating * 10) / 10,
    ratingCount: book.ratingCount,
    reviews: book.reviews
      .map((review) => review.trim())
      .filter(Boolean)
      .slice(0, MAX_REVIEW_SNIPPETS)
      .map((review) => truncate(review, MAX_REVIEW_LENGTH)),
  }));
}

function parseJsonObject(value: string): unknown {
  const cleaned = stripThinkBlocks(value)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response did not contain a JSON object.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseSummaryMap(rawResponse: string) {
  const parsed = parseJsonObject(rawResponse);
  const summaries = parsed as { summaries?: unknown };
  const items = Array.isArray(summaries.summaries) ? summaries.summaries : [];
  const summaryMap = new Map<string, BookAiSummary>();

  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;

    const summary = item as BookSummaryResponseItem;
    if (typeof summary.key !== "string") continue;

    const ratingSummary = typeof summary.ratingSummary === "string" ? summary.ratingSummary.trim() : "";

    if (!ratingSummary) continue;

    summaryMap.set(summary.key, {
      ratingSummary: truncate(ratingSummary, 180),
    });
  }

  return summaryMap;
}

export async function getBookLeaderboardSummaries(books: BookSummaryRequest[]) {
  if (!client || books.length === 0) {
    return new Map<string, BookAiSummary>();
  }

  const chatCompletion = await client.chat.completions.create({
    model: HF_MODEL,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content:
          "You write concise Discord embed copy for a book club leaderboard. Return only valid JSON. For each book, summarize the club's qualitative rating sentiment from the reviews and overall reception. Keep ratingSummary under 120 characters. Do not mention numeric scores, averages, rating counts, stars, points, or who gave which rating. Do not invent review details.",
      },
      {
        role: "user",
        content: JSON.stringify({
          responseShape: {
            summaries: [
              {
                key: "same key from input",
                ratingSummary: "club rating sentiment",
              },
            ],
          },
          books: compactBooksForPrompt(books),
        }),
      },
    ],
  });

  return parseSummaryMap(chatCompletion.choices[0]?.message.content || "");
}
