import "server-only";
import { MongoServerError, ObjectId, type ClientSession } from "mongodb";
import { getAuthConfig, getFixedOtpCode } from "./config";
import { hmac, randomOtp, safeEqualHex } from "./crypto";
import { getDb } from "./db";
import { COLLECTIONS, type OtpChallengeDoc, type OtpPurpose } from "./models";

// Phone-verification codes. Only an HMAC of each code is stored (keyed with
// AUTH_SECRET and bound to the challenge id), every guess is counted before
// it is checked, and a correct code is consumed with a conditional update so
// it can succeed exactly once.

export const OTP_TTL_MS = 5 * 60_000;
/** matches the 45-second countdown on the verification screen */
export const OTP_RESEND_COOLDOWN_MS = 45_000;
export const OTP_MAX_ATTEMPTS = 5;

const PURPOSE: OtpPurpose = "phone_verification";

async function challenges() {
  return (await getDb()).collection<OtpChallengeDoc>(COLLECTIONS.otpChallenges);
}

function codeHash(challengeId: ObjectId, code: string) {
  return hmac(getAuthConfig().secret, "otp", challengeId.toHexString(), code);
}

export function otpMessage(code: string) {
  return `Your Farm Korret Nig verification code is ${code}. It expires in 5 minutes. Never share this code with anyone.`;
}

export type IssueResult =
  | { status: "issued"; challengeId: ObjectId; code: string }
  | { status: "cooldown"; retryAfterSeconds: number };

/**
 * Replaces the user's active challenge with a fresh code, unless the current
 * one is still inside its resend cooldown. The partial unique index on
 * {userId, purpose, active: true} guarantees concurrent calls can't leave two
 * usable codes behind.
 */
export async function issueChallenge(
  userId: ObjectId,
  { dbSession, ignoreCooldown = false }: { dbSession?: ClientSession; ignoreCooldown?: boolean } = {},
): Promise<IssueResult> {
  const collection = await challenges();
  const now = new Date();

  if (!ignoreCooldown) {
    const current = await collection.findOne(
      { userId, purpose: PURPOSE, active: true },
      { session: dbSession },
    );
    if (current && current.resendAvailableAt > now) {
      return {
        status: "cooldown",
        retryAfterSeconds: Math.ceil((current.resendAvailableAt.getTime() - now.getTime()) / 1000),
      };
    }
  }

  // the cooldown condition is repeated here so a racing request can't retire
  // a code that was issued a moment ago; it then fails on the unique index
  await collection.updateMany(
    {
      userId,
      purpose: PURPOSE,
      active: true,
      ...(ignoreCooldown ? {} : { resendAvailableAt: { $lte: now } }),
    },
    { $set: { active: false, supersededAt: now } },
    { session: dbSession },
  );

  const challengeId = new ObjectId();
  const code = getFixedOtpCode() ?? randomOtp();

  try {
    await collection.insertOne(
      {
        _id: challengeId,
        userId,
        purpose: PURPOSE,
        codeHash: codeHash(challengeId, code),
        active: true,
        attempts: 0,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        resendAvailableAt: new Date(now.getTime() + OTP_RESEND_COOLDOWN_MS),
        createdAt: now,
        deliveredAt: null,
        deliveryFailedAt: null,
        consumedAt: null,
        supersededAt: null,
      },
      { session: dbSession },
    );
  } catch (error) {
    // another request issued a code between our supersede and insert
    if (error instanceof MongoServerError && error.code === 11000)
      return { status: "cooldown", retryAfterSeconds: Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000) };
    throw error;
  }
  return { status: "issued", challengeId, code };
}

export async function markChallengeDelivered(challengeId: ObjectId) {
  await (await challenges()).updateOne(
    { _id: challengeId },
    { $set: { deliveredAt: new Date() } },
  );
}

/**
 * The code never reached the phone: retire it and lift the cooldown so the
 * user can ask for another straight away.
 */
export async function markChallengeUndelivered(challengeId: ObjectId) {
  const now = new Date();
  await (await challenges()).updateOne(
    { _id: challengeId },
    { $set: { deliveryFailedAt: now, active: false, supersededAt: now, resendAvailableAt: now } },
  );
}

export type CheckResult =
  | { status: "correct"; challengeId: ObjectId }
  | { status: "incorrect"; attemptsLeft: number }
  | { status: "expired" }
  | { status: "too_many_attempts" }
  | { status: "no_challenge" };

/**
 * Spends one attempt on the active challenge and checks the code. The attempt
 * is recorded before the comparison, so parallel guesses can never exceed
 * OTP_MAX_ATTEMPTS in total.
 */
export async function checkCode(userId: ObjectId, code: string, now = new Date()): Promise<CheckResult> {
  const collection = await challenges();
  const challenge = await collection.findOneAndUpdate(
    { userId, purpose: PURPOSE, active: true, consumedAt: null, attempts: { $lt: OTP_MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!challenge) {
    const exhausted = await collection.findOne({ userId, purpose: PURPOSE, active: true });
    return exhausted ? { status: "too_many_attempts" } : { status: "no_challenge" };
  }
  if (challenge.expiresAt <= now) return { status: "expired" };

  if (safeEqualHex(challenge.codeHash, codeHash(challenge._id, code))) {
    return { status: "correct", challengeId: challenge._id };
  }
  const attemptsLeft = OTP_MAX_ATTEMPTS - challenge.attempts;
  return attemptsLeft > 0 ? { status: "incorrect", attemptsLeft } : { status: "too_many_attempts" };
}

/**
 * Marks a correctly answered challenge as used. Returns false if another
 * request consumed (or superseded) it first, so a code works only once.
 */
export async function consumeChallenge(challengeId: ObjectId, dbSession?: ClientSession): Promise<boolean> {
  const now = new Date();
  const result = await (await challenges()).updateOne(
    { _id: challengeId, active: true, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now, active: false } },
    { session: dbSession },
  );
  return result.modifiedCount === 1;
}

export async function deleteUserChallenges(userId: ObjectId, dbSession?: ClientSession) {
  await (await challenges()).deleteMany({ userId }, { session: dbSession });
}
