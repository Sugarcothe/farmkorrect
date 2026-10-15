import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { closeDb, getDb } from "@/lib/server/db";
import { signParams } from "@/lib/server/cloudinary";
import { ensureIndexes } from "@/lib/server/indexes";
import { clearBankListCache } from "@/lib/server/paystack";
import { outbox, resetOutbox } from "./outbox";
import { fakePaystack, resetPaystack, TEST_PAYSTACK_KEY } from "./paystack";

// Each test file gets a throwaway MongoDB replica set (transactions need one),
// and every outbound HTTP request is intercepted: SMS and email requests are
// captured in the outbox and nothing ever reaches Termii, Resend, Cloudinary
// or Paystack.

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
  SMS_DEV_CONSOLE: "",
  RESEND_API_KEY: "",
  EMAIL_FROM: "",
  CLOUDINARY_URL: "",
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-cloudinary-key",
  CLOUDINARY_API_SECRET: "test-cloudinary-secret",
  CLOUDINARY_FOLDER: "",
  TRUST_PROXY_HEADERS: "true",
  PAYSTACK_SECRET_KEY: TEST_PAYSTACK_KEY,
};

let replSet: MongoMemoryReplSet;

function stubTestEnv() {
  vi.unstubAllEnvs();
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB_NAME", "farmkorrect_test");
  for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);
}

const CLOUDINARY_API = `https://api.cloudinary.com/v1_1/${TEST_ENV.CLOUDINARY_CLOUD_NAME}/image/`;

/** A minimal Cloudinary Upload API: checks the request signature and keeps the files in memory. */
async function fakeCloudinary(action: string, form: FormData) {
  const fields: Record<string, string> = {};
  let file: Blob | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
    else file = value;
  }
  outbox.imageRequests.push(fields);
  const { api_key, signature, ...signed } = fields;
  if (api_key !== TEST_ENV.CLOUDINARY_API_KEY || signature !== signParams(signed, TEST_ENV.CLOUDINARY_API_SECRET))
    return Response.json({ error: { message: "Invalid Signature" } }, { status: 401 });
  if (outbox.imagesFailing) return Response.json({ error: { message: "Server error" } }, { status: 500 });

  const publicId = fields.public_id;
  if (action === "upload" && file) {
    const data = Buffer.from(await file.arrayBuffer());
    outbox.images.set(publicId, data);
    return Response.json({
      public_id: publicId,
      version: 1,
      width: 512,
      height: 512,
      format: "webp",
      bytes: data.byteLength,
      secure_url: `https://res.cloudinary.com/${TEST_ENV.CLOUDINARY_CLOUD_NAME}/image/upload/v1/${publicId}.webp`,
    });
  }
  if (action === "destroy") return Response.json({ result: outbox.images.delete(publicId) ? "ok" : "not found" });
  return Response.json({ error: { message: "Bad request" } }, { status: 400 });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.paystack.co/")) return fakePaystack(new URL(url), init);
  if (url.startsWith(CLOUDINARY_API)) return fakeCloudinary(url.slice(CLOUDINARY_API.length), init!.body as FormData);
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
  resetPaystack();
  clearBankListCache();
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
