import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BSON } from "mongodb";
import { mongoClient, BOOK_BOT_COLLECTION_NAME, BOOK_BOT_DB_NAME } from "../dist/mongo.js";
import { buildRatingMigrationPlan, compareMigrationDocuments, verifyRatingMigration } from "../dist/rating-migration.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
const mode = argumentsList[0] ?? "--dry-run";
if (!["--dry-run", "--apply", "--verify"].includes(mode) || argumentsList.length > 2) {
  throw new Error("Usage: node scripts/migrate-rating-book-ids.mjs [--dry-run|--apply|--verify] [baseline-directory]");
}
const baselineDirectory = path.resolve(argumentsList[1] ??
  (await readFile(path.join(repository, ".local/review-baselines/LATEST.txt"), "utf8")).trim());
const baselineText = await readFile(path.join(baselineDirectory, "baseline.ejson"), "utf8");
const summary = JSON.parse(await readFile(path.join(baselineDirectory, "summary.json"), "utf8"));
if (createHash("sha256").update(baselineText).digest("hex") !== summary.sha256) {
  throw new Error("The saved baseline failed its SHA-256 integrity check.");
}
const baseline = BSON.EJSON.parse(baselineText, { relaxed: false });
if (baseline.scope.database !== BOOK_BOT_DB_NAME || baseline.scope.collection !== BOOK_BOT_COLLECTION_NAME ||
    baseline.scope.allGuilds !== true || !Array.isArray(baseline.documents) || !Array.isArray(baseline.ratingBookMappings) ||
    baseline.associationIssues.length || baseline.duplicateMemberRatings.length) {
  throw new Error("The baseline scope or rating associations need review before migration.");
}
const savedMappings = baseline.ratingBookMappings.map((mapping) => ({
  ratingId: mapping.ratingId, bookId: mapping.expectedBookId, needsUpdate: false,
}));
const collection = mongoClient.db(BOOK_BOT_DB_NAME).collection(BOOK_BOT_COLLECTION_NAME);
const runDirectory = path.join(baselineDirectory, "migration-runs", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFile(path.join(runDirectory, name),
  BSON.EJSON.stringify(value, null, 2, { relaxed: false }) + "\n", { mode: 0o600 });
let report;

try {
  const current = await mongoClient.withSession((session) => session.withTransaction(
    () => collection.find({}, { session }).sort({ _id: 1 }).toArray(),
    { readConcern: { level: "snapshot" } },
  ));
  const plan = buildRatingMigrationPlan(current);
  const baselineComparison = compareMigrationDocuments(baseline.documents, current);
  const expectedAssociations = new Map(savedMappings.map((mapping) => [mapping.ratingId.toString(), mapping.bookId.toString()]));
  const changedAssociations = plan.mappings.filter((mapping) =>
    expectedAssociations.get(mapping.ratingId.toString()) !== mapping.bookId.toString(),
  ).map((mapping) => mapping.ratingId.toString());
  const indexes = await collection.listIndexes().toArray();
  // An old unique title-based member index would keep enforcing the old
  // relationship even after queries move to IDs. Report it for explicit handling.
  const legacyUniqueIndexes = indexes.filter((index) => index.unique && "normalizedTitle" in index.key && "userId" in index.key);
  report = {
    mode,
    baseline: baselineDirectory,
    books: plan.books,
    ratings: plan.ratings,
    toMigrate: plan.mappings.filter((mapping) => mapping.needsUpdate).length,
    alreadyLinked: plan.mappings.filter((mapping) => !mapping.needsUpdate).length,
    issues: plan.issues,
    baselineComparison,
    changedAssociations,
    legacyUniqueIndexes: legacyUniqueIndexes.map((index) => ({ name: index.name, key: index.key })),
    indexes: indexes.map((index) => ({ name: index.name, key: index.key, unique: index.unique ?? false })),
    reportDirectory: runDirectory,
  };
  await save("observed.ejson", current);
  await save("plan.ejson", plan);
  if (plan.issues.length || !baselineComparison.ok || changedAssociations.length || legacyUniqueIndexes.length) {
    throw new Error("Migration checks failed. See the saved report; no rating records were changed.");
  }
  if (mode === "--apply") {
    await collection.createIndex({ guildId: 1, bookId: 1, userId: 1 }, {
      name: "rating_by_book_and_member", unique: true,
      partialFilterExpression: { documentType: "rating", bookId: { $type: "objectId" } },
    });
    let attempt = 0;
    const result = await mongoClient.withSession((session) => session.withTransaction(async () => {
      attempt += 1;
      const before = await collection.find({}, { session }).sort({ _id: 1 }).toArray();
      const transactionPlan = buildRatingMigrationPlan(before);
      if (transactionPlan.issues.length || !compareMigrationDocuments(baseline.documents, before).ok ||
          transactionPlan.mappings.some((mapping) => expectedAssociations.get(mapping.ratingId.toString()) !== mapping.bookId.toString())) {
        throw new Error("Records changed before migration; no ratings were updated.");
      }
      await save(`pre-migration-${attempt}.ejson`, before);
      const pending = transactionPlan.mappings.filter((mapping) => mapping.needsUpdate);
      if (pending.length) {
        const result = await collection.bulkWrite(pending.map((mapping) => ({
          updateOne: {
            filter: { _id: mapping.ratingId, documentType: "rating", bookId: null },
            update: { $set: { bookId: mapping.bookId } },
          },
        })), { session });
        if (result.matchedCount !== pending.length || result.modifiedCount !== pending.length) {
          throw new Error("Not every planned rating was updated; the transaction will be rolled back.");
        }
      }
      const after = await collection.find({}, { session }).sort({ _id: 1 }).toArray();
      const verification = verifyRatingMigration(before, after, transactionPlan.mappings);
      if (!verification.ok) throw new Error("Record preservation failed; the transaction will be rolled back.");
      return { updated: pending.length, verification, after };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
    await save("post-migration.ejson", result.after);
    report.updated = result.updated;
    report.transactionVerification = result.verification;
  }
  if (mode === "--apply" || mode === "--verify") {
    const after = await collection.find({}).sort({ _id: 1 }).toArray();
    report.baselineVerification = verifyRatingMigration(baseline.documents, after, savedMappings);
    await save("verified.ejson", after);
    if (!report.baselineVerification.ok) throw new Error("The final comparison against the saved baseline failed.");
  }
  report.ok = true;
  await writeFile(path.join(runDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message = error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, "[REDACTED]");
  report = { ...report, ok: false, error: message, reportDirectory: runDirectory };
  await writeFile(path.join(runDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await mongoClient.close();
}
