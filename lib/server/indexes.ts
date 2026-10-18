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
    // the admin credential queue
    {
      key: { "profile.credentialStatus": 1, "profile.credentialSubmittedAt": 1 },
      name: "credential_queue",
      partialFilterExpression: { "profile.credentialStatus": "pending" },
    },
    // credential decisions whose notifications still have to be created
    { key: { notifySyncAt: 1 }, name: "notify_sync", partialFilterExpression: { notifySyncAt: { $type: "date" } } },
    // admin analytics: registrations in a period
    { key: { createdAt: 1 }, name: "created" },
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
  [COLLECTIONS.serviceBookings]: [
    { key: { reference: 1 }, name: "reference_unique", unique: true },
    { key: { customerUserId: 1, idempotencyKey: 1 }, name: "customer_idempotency", unique: true },
    // the same service can't be booked twice for one day while a booking is open
    {
      key: { customerUserId: 1, openKey: 1 },
      name: "customer_open_unique",
      unique: true,
      partialFilterExpression: { openKey: { $type: "string" } },
    },
    // My bookings and the provider's jobs, newest first
    { key: { customerUserId: 1, createdAt: -1, _id: -1 }, name: "customer_recent" },
    { key: { providerUserId: 1, createdAt: -1, _id: -1 }, name: "provider_recent" },
    // the job: lapsing requests, quotes and unpaid bookings
    { key: { status: 1, respondBy: 1 }, name: "respond_queue" },
    { key: { status: 1, payBy: 1 }, name: "pay_queue" },
    { key: { status: 1, "quote.validUntil": 1 }, name: "quote_queue" },
    { key: { ledgerSyncAt: 1 }, name: "ledger_sync", partialFilterExpression: { ledgerSyncAt: { $type: "date" } } },
    { key: { notifySyncAt: 1 }, name: "notify_sync", partialFilterExpression: { notifySyncAt: { $type: "date" } } },
    { key: { updatedAt: -1 }, name: "flagged", partialFilterExpression: { reviewIssue: { $type: "string" } } },
  ],
  [COLLECTIONS.servicePayments]: [
    { key: { reference: 1 }, name: "reference_unique", unique: true },
    // one payable attempt per booking at a time
    { key: { bookingId: 1 }, name: "one_active_per_booking", unique: true, partialFilterExpression: { active: true } },
    { key: { bookingId: 1, createdAt: -1 }, name: "booking_recent" },
    { key: { active: 1, updatedAt: 1 }, name: "active_queue" },
  ],
  [COLLECTIONS.serviceRefunds]: [
    { key: { reference: 1 }, name: "reference_unique", unique: true },
    { key: { bookingId: 1, createdAt: 1 }, name: "booking" },
    // a booking's payment is refunded once, and a late payment is returned once
    { key: { paymentReference: 1 }, name: "one_refund_per_payment", unique: true },
    { key: { status: 1, updatedAt: 1 }, name: "status_queue" },
  ],
  [COLLECTIONS.services]: [
    // an owner's current services, newest first
    { key: { ownerUserId: 1, archivedAt: 1, createdAt: -1 }, name: "owner_current" },
    // the Other Services directory: listed marketplace services, newest first
    {
      key: { active: 1, bookingAvailable: 1, archivedAt: 1, createdAt: -1, _id: -1 },
      name: "marketplace_recent",
      partialFilterExpression: { pricing: { $type: "string" } },
    },
    { key: { searchWords: 1 }, name: "marketplace_words", partialFilterExpression: { pricing: { $type: "string" } } },
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
    // analytics: a seller's ledger flows in a period, and the platform's
    { key: { userId: 1, createdAt: 1 }, name: "user_created" },
    { key: { createdAt: 1, type: 1 }, name: "created_type" },
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
    // payouts flagged for a person to look at (admin exceptions)
    { key: { updatedAt: -1 }, name: "flagged", partialFilterExpression: { issue: { $type: "string" } } },
    // analytics: payouts requested, paid or failed in a period
    { key: { userId: 1, requestedAt: 1 }, name: "user_requested" },
    { key: { requestedAt: 1 }, name: "requested" },
    { key: { paidAt: 1 }, name: "paid" },
    { key: { failedAt: 1 }, name: "failed" },
  ],
  [COLLECTIONS.products]: [
    { key: { sellerUserId: 1, archivedAt: 1, createdAt: -1 }, name: "seller_current" },
    // the Market: listed products, newest first
    { key: { active: 1, archivedAt: 1, createdAt: -1 }, name: "market" },
    // Market filters and sorts (lib/server/market.ts)
    { key: { active: 1, archivedAt: 1, category: 1, createdAt: -1 }, name: "market_category" },
    { key: { active: 1, archivedAt: 1, state: 1, createdAt: -1 }, name: "market_state" },
    { key: { active: 1, archivedAt: 1, priceKobo: 1, _id: -1 }, name: "market_price" },
    { key: { active: 1, archivedAt: 1, ratingAverage: -1, ratingCount: -1, _id: -1 }, name: "market_rating" },
    // Market keyword search; a collection can only have one text index
    {
      key: { name: "text", searchTerms: "text", description: "text" },
      name: "market_text",
      weights: { name: 10, searchTerms: 3, description: 2 },
      default_language: "english",
      // no product field picks its own language
      language_override: "textLanguage",
    },
    // admin analytics: listings created in a period
    { key: { createdAt: 1 }, name: "created" },
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
    // admin queues: open reported issues, and orders flagged for review
    {
      key: { "issue.closedAt": 1, "issue.reportedAt": 1 },
      name: "issues",
      partialFilterExpression: { "issue.reportedAt": { $type: "date" } },
    },
    { key: { updatedAt: -1 }, name: "flagged", partialFilterExpression: { reviewIssue: { $type: "string" } } },
    // analytics: orders paid, delivered or cancelled in a period, per seller and overall
    { key: { sellerUserId: 1, paidAt: 1 }, name: "seller_paid" },
    { key: { sellerUserId: 1, deliveredAt: 1 }, name: "seller_delivered" },
    { key: { sellerUserId: 1, cancelledAt: 1 }, name: "seller_cancelled" },
    { key: { paidAt: 1 }, name: "paid" },
    { key: { createdAt: 1 }, name: "created" },
    { key: { deliveredAt: 1 }, name: "delivered" },
    { key: { cancelledAt: 1 }, name: "cancelled" },
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
    // analytics: refunds processed (or failed) in a period
    { key: { status: 1, kind: 1, processedAt: 1 }, name: "status_processed" },
    { key: { status: 1, failedAt: 1 }, name: "status_failed" },
  ],
  [COLLECTIONS.reviews]: [
    // one review per customer per product, whatever its status
    { key: { productId: 1, reviewerUserId: 1 }, name: "one_per_customer", unique: true },
    // a product's published reviews, newest first, and its rating summary
    { key: { productId: 1, status: 1, createdAt: -1 }, name: "product_status" },
    // My Reviews
    { key: { reviewerUserId: 1, createdAt: -1 }, name: "reviewer_recent" },
    // the admin moderation queue
    { key: { status: 1, createdAt: -1 }, name: "moderation_queue" },
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
    // failed and exhausted deliveries (admin exceptions)
    { key: { state: 1, updatedAt: -1 }, name: "state_recent" },
  ],
  [COLLECTIONS.pushSubscriptions]: [
    { key: { endpointHash: 1 }, name: "endpoint_unique", unique: true },
    { key: { userId: 1, createdAt: -1 }, name: "user" },
  ],
  [COLLECTIONS.rateLimits]: [
    { key: { expiresAt: 1 }, name: "expiry_ttl", expireAfterSeconds: 0 },
  ],
  // append-only and never expired: kept until a retention period is decided
  [COLLECTIONS.adminAudit]: [
    { key: { at: -1, _id: -1 }, name: "recent" },
    { key: { action: 1, at: -1, _id: -1 }, name: "action_recent" },
    { key: { "target.type": 1, "target.id": 1, at: -1, _id: -1 }, name: "target_recent" },
    { key: { actorUserId: 1, at: -1, _id: -1 }, name: "actor_recent" },
  ],
  [COLLECTIONS.promotions]: [
    // a coupon code belongs to one promotion, whatever its status
    { key: { code: 1 }, name: "code_unique", unique: true, partialFilterExpression: { code: { $type: "string" } } },
    // the seller's list, newest first
    { key: { sellerUserId: 1, createdAt: -1 }, name: "seller_recent" },
    // live automatic sales for a seller's products (checkout and the Market)
    { key: { sellerUserId: 1, status: 1, code: 1, endsAt: 1 }, name: "seller_live" },
    { key: { status: 1, endsAt: 1 }, name: "status_expiry" },
  ],
  [COLLECTIONS.promotionRedemptions]: [
    // an order uses at most one promotion, once
    { key: { orderId: 1 }, name: "order_unique", unique: true },
    // the per-buyer limit
    { key: { promotionId: 1, buyerUserId: 1, status: 1 }, name: "promotion_buyer" },
    // a promotion's results
    { key: { promotionId: 1, status: 1 }, name: "promotion_status" },
    { key: { sellerUserId: 1, reservedAt: -1 }, name: "seller_recent" },
    // analytics: a seller's redeemed uses in a period and uses held now
    { key: { sellerUserId: 1, status: 1, redeemedAt: 1 }, name: "seller_status" },
  ],
  [COLLECTIONS.vetAvailability]: [
    // the appointment job rebuilds the least recently refreshed directory entries
    { key: { directoryRefreshedAt: 1 }, name: "directory_refresh" },
  ],
  [COLLECTIONS.vetDirectory]: [
    // directory pages: every query has listed: true, then keyset order on (key, _id)
    { key: { listed: 1, experienceKey: -1, _id: 1 }, name: "listed_experience" },
    { key: { listed: 1, nameKey: 1, _id: 1 }, name: "listed_name" },
    { key: { listed: 1, state: 1, experienceKey: -1, _id: 1 }, name: "listed_state_experience" },
    { key: { listed: 1, state: 1, nameKey: 1, _id: 1 }, name: "listed_state_name" },
    // word-prefix search
    { key: { searchWords: 1 }, name: "search_words" },
  ],
  [COLLECTIONS.appointments]: [
    { key: { reference: 1 }, name: "reference_unique", unique: true },
    // a retried booking returns the first one
    { key: { customerUserId: 1, idempotencyKey: 1 }, name: "customer_idempotency", unique: true },
    // each party's list, newest start first
    { key: { customerUserId: 1, startsAt: -1, _id: -1 }, name: "customer_recent" },
    { key: { vetUserId: 1, startsAt: -1, _id: -1 }, name: "vet_recent" },
    // a customer's open requests (the cap on open bookings)
    { key: { customerUserId: 1, bookingStatus: 1 }, name: "customer_status" },
    // unanswered requests that lapse
    { key: { bookingStatus: 1, respondBy: 1 }, name: "status_respond_by" },
    { key: { notifySyncAt: 1 }, name: "notify_sync", partialFilterExpression: { notifySyncAt: { $type: "date" } } },
  ],
  [COLLECTIONS.appointmentSlots]: [
    // no two appointments can hold the same unit of a vet's time
    { key: { vetUserId: 1, startsAt: 1 }, name: "vet_unit_unique", unique: true },
    { key: { appointmentId: 1 }, name: "appointment" },
  ],
  [COLLECTIONS.courses]: [
    // the catalogue: every learner query has status "published", newest publication first
    { key: { status: 1, publishedAt: -1, _id: -1 }, name: "status_published" },
    { key: { status: 1, category: 1, publishedAt: -1, _id: -1 }, name: "status_category_published" },
    { key: { status: 1, featured: 1, publishedAt: -1 }, name: "status_featured" },
    // word-prefix search
    { key: { searchWords: 1 }, name: "search_words" },
    // the admin list
    { key: { updatedAt: -1, _id: -1 }, name: "recently_updated" },
  ],
  [COLLECTIONS.courseEnrollments]: [
    // one enrolment per learner and course
    { key: { userId: 1, courseId: 1 }, name: "learner_course_unique", unique: true },
    // Continue Learning
    { key: { userId: 1, lastActivityAt: -1 }, name: "learner_recent" },
  ],
  [COLLECTIONS.lessonProgress]: [
    // one record per learner, course and lesson; also serves every progress read
    { key: { userId: 1, courseId: 1, lessonId: 1 }, name: "learner_lesson_unique", unique: true },
  ],
  [COLLECTIONS.farmStaff]: [
    // one open invitation or membership per farm and phone number
    { key: { farmId: 1, phoneNormalized: 1 }, name: "farm_phone_open", unique: true, partialFilterExpression: { open: true } },
    { key: { farmId: 1, status: 1, invitedAt: -1 }, name: "farm_status" },
    // invitations for a phone number, and a member's farms
    { key: { phoneNormalized: 1, status: 1 }, name: "phone_status" },
    { key: { userId: 1, status: 1 }, name: "member_status" },
  ],
  [COLLECTIONS.trainingPrograms]: [{ key: { farmId: 1, role: 1 }, name: "farm_role_unique", unique: true }],
};

export async function ensureIndexes(db: Db): Promise<string[]> {
  const created: string[] = [];
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    const names = await db.collection(collection).createIndexes(indexes);
    created.push(...names.map((name) => `${collection}.${name}`));
  }
  return created;
}
