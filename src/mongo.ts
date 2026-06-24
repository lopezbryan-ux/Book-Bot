import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MONGODB_URI = process.env.MONGODB_URI;
export const BOOK_BOT_DB_NAME = "BookBotCluster";
export const BOOK_BOT_COLLECTION_NAME = "BookBotCollection";
export const BOOK_NOMINATIONS_COLLECTION_NAME = "BookBotNominations";
export const BOOK_POLLS_COLLECTION_NAME = "BookBotPolls";

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is missing from the environment.");
}

export const mongoClient = new MongoClient(MONGODB_URI);
