// Fills in (or recomputes) every product's search data: the words its
// category is found by and the summary of its published reviews used by the
// Market's rating filter and sort. Reads only products and reviews and
// changes nothing else. Safe to run repeatedly and while the app is live.
//
// Run once after deploying Market search (after `npm run db:setup`), and
// again after changing review statuses directly in the database:
//   npm run db:rebuild-search
import { existsSync } from "node:fs";
import { MongoClient } from "mongodb";
import { rebuildCatalogSearch } from "../lib/server/catalog";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is not set.");
  const dbName = process.env.MONGODB_DB_NAME?.trim() || "farmkorrect";

  const client = new MongoClient(uri, { appName: "farm-korret-nig-rebuild-search" });
  try {
    await client.connect();
    const { products } = await rebuildCatalogSearch(client.db(dbName));
    console.log(`Search data rebuilt for ${products} products on "${dbName}".`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(`db:rebuild-search failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
