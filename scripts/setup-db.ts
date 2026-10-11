// Creates (or confirms) every MongoDB index the app relies on. Safe to run
// repeatedly; run it once per environment before first deploy and after any
// change to lib/server/indexes.ts:  npm run db:setup
import { existsSync } from "node:fs";
import { MongoClient } from "mongodb";
import { ensureIndexes } from "../lib/server/indexes";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is not set.");
  const dbName = process.env.MONGODB_DB_NAME?.trim() || "farmkorrect";

  const client = new MongoClient(uri, { appName: "farm-korret-nig-setup" });
  try {
    await client.connect();
    const created = await ensureIndexes(client.db(dbName));
    console.log(`Indexes ready on "${dbName}": ${created.join(", ")}`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  // the driver's messages can include the host, never the password; keep it short anyway
  console.error(`db:setup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
