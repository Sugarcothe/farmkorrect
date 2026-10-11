import "server-only";
import { MongoServerError, ObjectId, type ClientSession } from "mongodb";
import type { SessionUser } from "@/lib/auth/types";
import { getDb, getMongoClient } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type UserDoc } from "./models";
import { deleteUserChallenges, issueChallenge } from "./otp";
import { createSession, revokeUserSessions, type IssuedSession } from "./sessions";
import type { RegistrationInput } from "./validation";

/** Unverified sign-ups are deleted by a TTL index after this long. */
export const PENDING_ACCOUNT_TTL_MS = 24 * 60 * 60_000;

export async function users() {
  return (await getDb()).collection<UserDoc>(COLLECTIONS.users);
}

export async function findUserByIdentifier(identifier: { kind: "email" | "phone"; value: string }) {
  const field = identifier.kind === "email" ? "emailNormalized" : "phoneNormalized";
  return (await users()).findOne({ [field]: identifier.value });
}

export function toSessionUser(user: UserDoc): SessionUser {
  return {
    fullName: user.fullName,
    role: user.role,
    email: user.emailNormalized,
    phone: user.phoneNormalized,
  };
}

const DUPLICATE_MESSAGES = {
  email: "An account with this email address already exists. Log in instead.",
  phone: "An account with this phone number already exists. Log in instead.",
};

function duplicateError(fields: Array<"email" | "phone">) {
  const fieldErrors: Record<string, string> = {};
  for (const field of fields) fieldErrors[field] = DUPLICATE_MESSAGES[field];
  return new HttpError(409, "An account with these details already exists.", fieldErrors);
}

export type PendingRegistration = {
  userId: ObjectId;
  challengeId: ObjectId;
  code: string;
  session: IssuedSession;
};

/**
 * Creates an unverified account, its first verification code and a pending
 * session in one transaction. Earlier *unverified* sign-ups using the same
 * email or phone are replaced (their owner never proved the phone); verified
 * accounts are never touched and produce a 409 instead. The unique indexes
 * settle any race between concurrent registrations.
 */
export async function createPendingRegistration(
  input: RegistrationInput,
  passwordHash: string,
): Promise<PendingRegistration> {
  const client = await getMongoClient();
  const collection = await users();

  try {
    return await client.withSession((dbSession) =>
      dbSession.withTransaction(async () => {
        const now = new Date();
        const existing = await collection
          .find(
            { $or: [{ emailNormalized: input.email }, { phoneNormalized: input.phone }] },
            { session: dbSession, projection: { status: 1, emailNormalized: 1, phoneNormalized: 1 } },
          )
          .toArray();

        const taken = new Set<"email" | "phone">();
        for (const user of existing) {
          if (user.status === "pending_verification") continue;
          if (user.emailNormalized === input.email) taken.add("email");
          if (user.phoneNormalized === input.phone) taken.add("phone");
        }
        if (taken.size > 0) throw duplicateError([...taken]);

        for (const stale of existing) await discardPendingUser(stale._id, dbSession);

        const userId = new ObjectId();
        await collection.insertOne(
          {
            _id: userId,
            fullName: input.fullName,
            emailNormalized: input.email,
            phoneNormalized: input.phone,
            passwordHash,
            role: input.role,
            status: "pending_verification",
            phoneVerifiedAt: null,
            emailVerifiedAt: null,
            pendingExpiresAt: new Date(now.getTime() + PENDING_ACCOUNT_TTL_MS),
            createdAt: now,
            updatedAt: now,
          },
          { session: dbSession },
        );

        const challenge = await issueChallenge(userId, { dbSession, ignoreCooldown: true });
        if (challenge.status !== "issued") throw new Error("Could not create a verification code");
        const session = await createSession(userId, "pending", dbSession, now);
        return { userId, challengeId: challenge.challengeId, code: challenge.code, session };
      }),
    );
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const key = Object.keys((error.keyPattern as Record<string, unknown> | undefined) ?? {});
      const fields: Array<"email" | "phone"> = [];
      if (key.includes("emailNormalized")) fields.push("email");
      if (key.includes("phoneNormalized")) fields.push("phone");
      throw duplicateError(fields.length ? fields : ["email", "phone"]);
    }
    throw error;
  }
}

/**
 * Removes an account that never verified its phone, with its codes and
 * sessions. The status filter makes it impossible to delete a verified account.
 */
export async function discardPendingUser(userId: ObjectId, dbSession?: ClientSession) {
  const result = await (await users()).deleteOne(
    { _id: userId, status: "pending_verification" },
    { session: dbSession },
  );
  if (result.deletedCount === 1) {
    await deleteUserChallenges(userId, dbSession);
    await revokeUserSessions(userId, dbSession);
  }
}

/** Marks the phone verified and the account active. */
export async function activateUser(userId: ObjectId, dbSession?: ClientSession): Promise<boolean> {
  const now = new Date();
  const result = await (await users()).updateOne(
    { _id: userId, status: "pending_verification" },
    {
      $set: { status: "active", phoneVerifiedAt: now, updatedAt: now },
      $unset: { pendingExpiresAt: "" },
    },
    { session: dbSession },
  );
  return result.modifiedCount === 1;
}

export async function updatePasswordHash(userId: ObjectId, passwordHash: string, dbSession?: ClientSession) {
  await (await users()).updateOne(
    { _id: userId },
    { $set: { passwordHash, updatedAt: new Date() } },
    { session: dbSession },
  );
}
