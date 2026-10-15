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
  [COLLECTIONS.services]: [
    // an owner's current services, newest first
    { key: { ownerUserId: 1, archivedAt: 1, createdAt: -1 }, name: "owner_current" },
  ],
  [COLLECTIONS.payoutAccounts]: [
    // one account per owner receives payouts
    {
      key: { ownerUserId: 1 },
      name: "one_current_per_owner",
      unique: true,
      partialFilterExpression: { current: true },
    },
    { key: { ownerUserId: 1, createdAt: -1 }, name: "owner_history" },
  ],
  [COLLECTIONS.bankVerifications]: [
    { key: { tokenHash: 1 }, name: "token_unique", unique: true },
    // at most one confirmable check per user
    {
      key: { userId: 1 },
      name: "one_active_per_user",
      unique: true,
      partialFilterExpression: { active: true },
    },
    // gone an hour after expiry; they hold the account name, so not kept long
    { key: { expiresAt: 1 }, name: "expiry_ttl", expireAfterSeconds: 3_600 },
  ],
  [COLLECTIONS.ledgerEntries]: [
    // the same earning, fee, refund or payout step can only be recorded once
    { key: { idempotencyKey: 1 }, name: "idempotency_unique", unique: true },
    // a user's history, newest first, and the per-user write order
    { key: { userId: 1, sequence: -1 }, name: "user_sequence", unique: true },
    { key: { "source.type": 1, "source.id": 1 }, name: "source" },
    { key: { payoutId: 1 }, name: "payout", partialFilterExpression: { payoutId: { $type: "objectId" } } },
  ],
  [COLLECTIONS.fulfillments]: [
    { key: { sourceType: 1, sourceId: 1 }, name: "source_unique", unique: true },
  ],
  [COLLECTIONS.payouts]: [
    { key: { userId: 1, idempotencyKey: 1 }, name: "idempotency_unique", unique: true },
    { key: { reference: 1 }, name: "reference_unique", unique: true },
    { key: { userId: 1, createdAt: -1 }, name: "user_recent" },
    // the processing job's queue
    { key: { status: 1, updatedAt: 1 }, name: "status_queue" },
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
