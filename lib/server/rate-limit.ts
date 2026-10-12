import "server-only";
import { MongoServerError } from "mongodb";
import { getAuthConfig } from "./config";
import { hmac } from "./crypto";
import { getDb } from "./db";
import { COLLECTIONS, type RateLimitDoc } from "./models";

// Fixed-window counters stored in MongoDB, so limits hold across every server
// instance. Keys are HMACed: the collection never holds raw IPs, phone numbers
// or email addresses. Expired windows are removed by a TTL index.

export type Limit = { limit: number; windowMs: number };

export const LIMITS = {
  registerPerIp: { limit: 10, windowMs: 60 * 60_000 },
  registerPerPhone: { limit: 5, windowMs: 60 * 60_000 },
  loginFailuresPerIp: { limit: 30, windowMs: 15 * 60_000 },
  loginFailuresPerAccount: { limit: 5, windowMs: 15 * 60_000 },
  otpVerifyPerIp: { limit: 30, windowMs: 15 * 60_000 },
  otpSendsPerPhone: { limit: 5, windowMs: 60 * 60_000 },
  otpSendsPerIp: { limit: 15, windowMs: 60 * 60_000 },
  resetRequestsPerIdentifier: { limit: 3, windowMs: 60 * 60_000 },
  resetRequestsPerIp: { limit: 10, windowMs: 60 * 60_000 },
  resetAttemptsPerIp: { limit: 20, windowMs: 15 * 60_000 },
} satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

export type RateLimitResult = { limited: boolean; retryAfterSeconds: number };

function windowKey(name: LimitName, subject: string, now: number) {
  const { windowMs } = LIMITS[name];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  return {
    id: hmac(getAuthConfig().secret, "rate-limit", name, subject, String(windowStart)),
    windowEnd: windowStart + windowMs,
  };
}

function result(count: number, name: LimitName, windowEnd: number, now: number): RateLimitResult {
  const limited = count > LIMITS[name].limit;
  return { limited, retryAfterSeconds: limited ? Math.ceil((windowEnd - now) / 1000) : 0 };
}

/** Counts one event and reports whether the subject is now over the limit. */
export async function hit(name: LimitName, subject: string, now = Date.now()): Promise<RateLimitResult> {
  const { id, windowEnd } = windowKey(name, subject, now);
  const collection = (await getDb()).collection<RateLimitDoc>(COLLECTIONS.rateLimits);
  const update = {
    $inc: { count: 1 },
    $setOnInsert: { expiresAt: new Date(windowEnd) },
  };
  let doc: RateLimitDoc | null;
  try {
    doc = await collection.findOneAndUpdate({ _id: id }, update, {
      upsert: true,
      returnDocument: "after",
    });
  } catch (error) {
    // two first hits raced on the upsert; the document exists now
    if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
    doc = await collection.findOneAndUpdate({ _id: id }, update, { returnDocument: "after" });
  }
  return result(doc?.count ?? 1, name, windowEnd, now);
}

/** Reports whether the subject has already used up the limit, without counting. */
export async function peek(name: LimitName, subject: string, now = Date.now()): Promise<RateLimitResult> {
  const { id, windowEnd } = windowKey(name, subject, now);
  const doc = await (await getDb())
    .collection<RateLimitDoc>(COLLECTIONS.rateLimits)
    .findOne({ _id: id });
  // "already over" means the next attempt would exceed the limit
  return result((doc?.count ?? 0) + 1, name, windowEnd, now);
}

export async function reset(name: LimitName, subject: string, now = Date.now()) {
  const { id } = windowKey(name, subject, now);
  await (await getDb()).collection<RateLimitDoc>(COLLECTIONS.rateLimits).deleteOne({ _id: id });
}
