import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { closeDb, getDb } from "@/lib/server/db";
import { ensureIndexes } from "@/lib/server/indexes";
import { outbox, resetOutbox } from "./outbox";

// Each test file gets a throwaway MongoDB replica set (transactions need one),
// and every outbound HTTP request is intercepted: SMS and email requests are
// captured in the outbox and nothing ever reaches Termii or Resend.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  const { pendingAfter } = await import("./outbox");
  return { ...actual, after: (task: () => unknown) => void pendingAfter.push(task) };
});

const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
  SESSION_COOKIE_NAME: "fk_session",
  TERMII_API_KEY: "test-termii-key",
  TERMII_SENDER_ID: "FarmKorret",
  TERMII_BASE_URL: "https://termii.invalid",
  TERMII_CHANNEL: "dnd",
  RESEND_API_KEY: "",
  EMAIL_FROM: "",
  TRUST_PROXY_HEADERS: "true",
};

let replSet: MongoMemoryReplSet;

function stubTestEnv() {
  vi.unstubAllEnvs();
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB_NAME", "farmkorrect_test");
  for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = input instanceof Request ? input.url : String(input);
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  if (url === "https://termii.invalid/api/sms/send") {
    outbox.sms.push({ to: String(body.to), text: String(body.sms) });
    if (outbox.smsFailing) return Response.json({ code: "error", message: "failed" }, { status: 400 });
    return Response.json({ message_id: `msg-${outbox.sms.length}`, message: "Successfully Sent" });
  }
  if (url === "https://api.resend.com/emails") {
    const to = body.to as string[];
    outbox.email.push({ to: to[0], subject: String(body.subject), text: String(body.text) });
    return Response.json({ id: `email-${outbox.email.length}` });
  }
  throw new Error(`Unexpected outbound request in tests: ${url}`);
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  stubTestEnv();
  await ensureIndexes(await getDb());
});

beforeEach(async () => {
  stubTestEnv();
  resetOutbox();
  vi.stubGlobal("fetch", fakeFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});

  const db = await getDb();
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray())
    await db.collection(name).deleteMany({});
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
  await replSet?.stop();
});
