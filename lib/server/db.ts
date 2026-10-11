import "server-only";
import { MongoClient, type Db } from "mongodb";
import { getDatabaseConfig } from "./config";

// One MongoClient per server process. In development the module is re-evaluated
// on every hot reload, so the client is parked on globalThis to avoid opening
// a new connection pool each time.

type Cached = { uri: string; client: Promise<MongoClient> };

const globalForMongo = globalThis as typeof globalThis & {
  __fkMongo?: Cached;
};

function getClient(uri: string): Promise<MongoClient> {
  const cached = globalForMongo.__fkMongo;
  if (cached && cached.uri === uri) return cached.client;

  const client = new MongoClient(uri, {
    appName: "farm-korret-nig",
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8_000,
  })
    .connect()
    .catch((error: unknown) => {
      // don't cache a failed connection; the next request retries
      if (globalForMongo.__fkMongo?.client === client) delete globalForMongo.__fkMongo;
      throw error;
    });
  globalForMongo.__fkMongo = { uri, client };
  return client;
}

export async function getMongoClient(): Promise<MongoClient> {
  return getClient(getDatabaseConfig().uri);
}

export async function getDb(): Promise<Db> {
  const { uri, dbName } = getDatabaseConfig();
  return (await getClient(uri)).db(dbName);
}

/** Closes the shared client (scripts and tests). */
export async function closeDb() {
  const cached = globalForMongo.__fkMongo;
  delete globalForMongo.__fkMongo;
  if (cached) await (await cached.client.catch(() => null))?.close();
}
