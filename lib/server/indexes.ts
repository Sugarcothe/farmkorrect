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
    // changes whose notifications still have to be created (the notification job's queue)
    { key: { notifySyncAt: 1 }, name: "notify_sync", partialFilterExpression: { notifySyncAt: { $type: "date" } } },
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
    // changes whose notifications still have to be created (the notification job's queue)
    { key: { notifySyncAt: 1 }, name: "notify_sync", partialFilterExpression: { notifySyncAt: { $type: "date" } } },
  ],
  [COLLECTIONS.products]: [
    { key: { sellerUserId: 1, archivedAt: 1, createdAt: -1 }, name: "seller_current" },
    // the Market: listed products, newest first
    { key: { active: 1, archivedAt: 1, createdAt: -1 }, name: "market" },
  ],
  [COLLECTIONS.orders]: [
    { key: { number: 1 }, name: "number_unique", unique: true },
    { key: { buyerUserId: 1, idempotencyKey: 1 }, name: "idempotency_unique", unique: true },
    { key: { buyerUserId: 1, createdAt: -1 }, name: "buyer_recent" },
    { key: { sellerUserId: 1, createdAt: -1 }, name: "seller_recent" },
    // the job's queues: unpaid orders to expire, paid orders to settle
    { key: { paymentStatus: 1, "inventory.expiresAt": 1 }, name: "unpaid_expiry" },
    { key: { settlement: 1, paidAt: 1 }, name: "unsettled", partialFilterExpression: { paidAt: { $type: "date" } } },
    { key: { ledgerSyncAt: 1 }, name: "ledger_sync", partialFilterExpression: { ledgerSyncAt: { $type: "date" } } },
    // cancelled orders whose stock hasn't been given back yet
    { key: { fulfillmentStatus: 1, "inventory.releasedAt": 1 }, name: "release_queue" },
    // changes whose notifications still have to be created (the notification job's queue)
    { key: { notifySyncAt: 1 }, name: "notify_sync", partialFilterExpression: { notifySyncAt: { $type: "date" } } },
  ],
  [COLLECTIONS.payments]: [
    { key: { reference: 1 }, name: "reference_unique", unique: true },
    // one payable attempt per order at a time
    { key: { orderId: 1 }, name: "one_active_per_order", unique: true, partialFilterExpression: { active: true } },
    { key: { orderId: 1, createdAt: -1 }, name: "order_recent" },
    { key: { active: 1, updatedAt: 1 }, name: "active_queue" },
  ],
  [COLLECTIONS.refunds]: [
    { key: { reference: 1 }, name: "reference_unique", unique: true },
    { key: { orderId: 1, createdAt: 1 }, name: "order" },
    {
      key: { orderId: 1, idempotencyKey: 1 },
      name: "idempotency_unique",
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: "string" } },
    },
    // a payment that arrived late is returned once
    {
      key: { paymentReference: 1 },
      name: "one_late_refund_per_payment",
      unique: true,
      partialFilterExpression: { kind: "late_payment" },
    },
    { key: { status: 1, updatedAt: 1 }, name: "status_queue" },
  ],
  [COLLECTIONS.reviews]: [
    // one review per customer per product, whatever its status
    { key: { productId: 1, reviewerUserId: 1 }, name: "one_per_customer", unique: true },
    // a product's published reviews, newest first, and its rating summary
    { key: { productId: 1, status: 1, createdAt: -1 }, name: "product_status" },
    // My Reviews
    { key: { reviewerUserId: 1, createdAt: -1 }, name: "reviewer_recent" },
    // changes whose notifications still have to be created (the notification job's queue)
    { key: { notifySyncAt: 1 }, name: "notify_sync", partialFilterExpression: { notifySyncAt: { $type: "date" } } },
  ],
  [COLLECTIONS.notifications]: [
    // the same event notifies the same person at most once
    { key: { recipientUserId: 1, eventKey: 1 }, name: "event_unique", unique: true },
    // the inbox, newest first
    { key: { recipientUserId: 1, createdAt: -1, _id: -1 }, name: "recipient_recent" },
    // the unread count and the Unread filter
    { key: { recipientUserId: 1, readAt: 1, createdAt: -1 }, name: "recipient_unread" },
    // the category filter
    { key: { recipientUserId: 1, category: 1, createdAt: -1 }, name: "recipient_category" },
  ],
  [COLLECTIONS.notificationDeliveries]: [
    // one delivery per notification and channel
    { key: { notificationId: 1, channel: 1 }, name: "notification_channel_unique", unique: true },
    // the dispatch queue and abandoned claims
    { key: { state: 1, nextAttemptAt: 1 }, name: "dispatch_queue" },
    { key: { state: 1, claimedAt: 1 }, name: "claims" },
  ],
  [COLLECTIONS.pushSubscriptions]: [
    { key: { endpointHash: 1 }, name: "endpoint_unique", unique: true },
    { key: { userId: 1, createdAt: -1 }, name: "user" },
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
