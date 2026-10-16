import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ObjectId } from "mongodb";
import { getOrderJobSecret } from "./config";
import { HttpError, tooManyRequests } from "./http";
import { hit, type LimitName } from "./rate-limit";

// Checks shared by the product and order routes.

export const ORDERS_UNVERIFIED = "Verify your phone number before using the Market.";

export async function limitUser(name: LimitName, userId: ObjectId, message?: string) {
  const limit = await hit(name, userId.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds, message);
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The internal order endpoints take "Authorization: Bearer <ORDER_JOB_SECRET>"
 * and don't exist at all (404) while that secret is unset.
 */
export function requireOrderJobSecret(request: Request) {
  const secret = getOrderJobSecret();
  if (!secret) throw new HttpError(404, "Not found.");
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // compared as fixed-length digests, in constant time
  if (!given || !timingSafeEqual(digest(given), digest(secret))) throw new HttpError(401, "Not authorized.");
}
