import type { Db, IndexDescription } from "mongodb";
import { COLLECTIONS } from "./models";

// Every index the app relies on. Created by `npm run db:setup` (and by the
// test suite) rather than at request time, so the runtime database user
// doesn't need index-management rights. createIndexes is idempotent.

const INDEXES: Record<string, IndexDescription[]> = {
  [COLLECTIONS.users]: [
    { key: { emailNormalized: 1 }, name: "email_unique", unique: true },
    { key: { phoneNormalized: 1 }, name: "phone_unique", unique: true },
    // never-verified sign-ups are cleaned up automatically
    { key: { pendingExpiresAt: 1 }, name: "pending_ttl", expireAfterSeconds: 0 },
  ],
  [COLLECTIONS.sessions]: [
    { key: { tokenHash: 1 }, name: "token_unique", unique: true },
    { key: { userId: 1 }, name: "user" },
    { key: { expiresAt: 1 }, name: "expiry_ttl", expireAfterSeconds: 0 },
  ],
  [COLLECTIONS.otpChallenges]: [
    // at most one usable challenge per user and purpose
    {
      key: { userId: 1, purpose: 1 },
      name: "one_active_per_user",
      unique: true,
      partialFilterExpression: { active: true },
    },
    // kept a day past expiry for support/debugging, then removed
    { key: { expiresAt: 1 }, name: "expiry_ttl", expireAfterSeconds: 86_400 },
  ],
  [COLLECTIONS.passwordResets]: [
    { key: { tokenHash: 1 }, name: "token_unique", unique: true },
    { key: { userId: 1 }, name: "user" },
    { key: { expiresAt: 1 }, name: "expiry_ttl", expireAfterSeconds: 86_400 },
  ],
  [COLLECTIONS.farms]: [
    {
      key: { ownerUserId: 1 },
      name: "one_initial_profile_per_owner",
      unique: true,
      partialFilterExpression: { initialProfile: true },
    },
    { key: { ownerUserId: 1, createdAt: -1 }, name: "owner_recent" },
    { key: { farmType: 1 }, name: "farm_type" },
  ],
  [COLLECTIONS.rateLimits]: [
    { key: { expiresAt: 1 }, name: "expiry_ttl", expireAfterSeconds: 0 },
  ],
};

export async function ensureIndexes(db: Db): Promise<string[]> {
  const created: string[] = [];
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    const names = await db.collection(collection).createIndexes(indexes);
    created.push(...names.map((name) => `${collection}.${name}`));
  }
  return created;
}
