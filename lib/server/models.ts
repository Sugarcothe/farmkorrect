import type { ObjectId } from "mongodb";
import type { FarmType, Role } from "@/lib/auth/types";
import type { PayoutAccountStatus } from "@/lib/bank-details/types";
import type { AdminAction, AuditTargetType } from "@/lib/admin/types";
import type { NigerianState } from "@/lib/locations/nigeria";
import type {
  FulfillmentMethod,
  FulfillmentStatus,
  OrderActor,
  OrderEventName,
  PaymentStatus,
  ProductCategory,
  ProductFulfillment,
  ProductUnit,
} from "@/lib/orders/types";
import type { CredentialStatus } from "@/lib/profile/types";
import type { PromotionScope, PromotionStatus, PromotionType } from "@/lib/promotions/types";
import type {
  ExternalChannel,
  NotificationCategory,
  NotificationPreferences,
  NotificationType,
} from "@/lib/notifications/types";
import type { ReviewStatus } from "@/lib/reviews/types";
import type { MarketplaceCategory, ServicePricing } from "@/lib/services/config";
import type {
  BookingDetails,
  ContactPreference,
  ServiceBookingActor,
  ServiceBookingEvent,
  ServiceBookingStatus,
  ServicePaymentStatus,
  TimeWindow,
} from "@/lib/services/marketplace";
import type { CourseCategory, CourseStatus, Difficulty, StaffRole, StaffStatus } from "@/lib/training/types";
import type { AppointmentActor, AppointmentPaymentStatus, BookingStatus, SlotMinutes, WeeklyHours } from "@/lib/vets/types";
import type { VisitNotes } from "@/lib/vets/visit";
import type {
  Currency,
  EarningSourceType,
  LedgerEntryType,
  PayoutFailureReason,
  PayoutStatus,
} from "@/lib/wallet/types";

// Shapes of the documents persisted in MongoDB. Nothing here is ever sent to
// the browser as-is; see the public types in lib/auth/types.ts.

export const COLLECTIONS = {
  users: "users",
  sessions: "sessions",
  otpChallenges: "otp_challenges",
  passwordResets: "password_resets",
  farms: "farms",
  rateLimits: "rate_limits",
  services: "services",
  payoutAccounts: "payout_accounts",
  bankVerifications: "bank_verifications",
  ledgerEntries: "ledger_entries",
  fulfillments: "fulfillments",
  walletAccounts: "wallet_accounts",
  payouts: "payouts",
  providerEvents: "provider_events",
  products: "products",
  orders: "orders",
  payments: "payments",
  refunds: "refunds",
  reviews: "reviews",
  notifications: "notifications",
  notificationDeliveries: "notification_deliveries",
  notificationPreferences: "notification_preferences",
  pushSubscriptions: "push_subscriptions",
  adminAudit: "admin_audit",
  promotions: "promotions",
  promotionRedemptions: "promotion_redemptions",
  vetAvailability: "vet_availability",
  vetDirectory: "vet_directory",
  appointments: "appointments",
  appointmentSlots: "appointment_slots",
  courses: "courses",
  courseEnrollments: "course_enrollments",
  lessonProgress: "lesson_progress",
  farmStaff: "farm_staff",
  trainingPrograms: "training_programs",
  serviceBookings: "service_bookings",
  servicePayments: "service_payments",
  serviceRefunds: "service_refunds",
} as const;

export type UserStatus = "pending_verification" | "active";

export type UserDoc = {
  _id: ObjectId;
  fullName: string;
  emailNormalized: string;
  /** E.164, e.g. +2348123456789 */
  phoneNormalized: string;
  /** Argon2id PHC string */
  passwordHash: string;
  role: Role;
  status: UserStatus;
  phoneVerifiedAt: Date | null;
  /** email verification isn't implemented yet, so this stays null */
  emailVerifiedAt: Date | null;
  /** pending accounts are removed by a TTL index if never verified */
  pendingExpiresAt?: Date;
  /** set the first time the user edits their profile; absent until then */
  profile?: UserProfileDoc;
  /**
   * Set with a credential decision that notifies the user; cleared once the
   * notification exists (the notification job retries it). Absent otherwise.
   */
  notifySyncAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Self-described profile details. Farmers' farm details live in the farms
 * collection; the photo file itself is stored on Cloudinary.
 */
export type UserProfileDoc = {
  bio?: string;
  /** professionals: where they practise */
  location?: string;
  /** professionals: years in practice */
  yearsOfExperience?: number;
  specialization?: string;
  qualifications?: string;
  registrationNumber?: string;
  /**
   * Only ever "pending" from the profile API; "verified" or "rejected" is set
   * by an admin in the admin area (the audit trail records who and why).
   */
  credentialStatus?: CredentialStatus;
  credentialSubmittedAt?: Date;
  /** when an admin last decided on the credential (the audit trail is authoritative) */
  credentialReviewedAt?: Date;
  photo?: ProfilePhotoRef;
};

/**
 * "pending" sessions only allow phone verification and code resends for a
 * freshly registered (or logged-in but unverified) account; "full" sessions
 * are issued once the phone is verified.
 */
export type SessionKind = "pending" | "full";

export type SessionDoc = {
  _id: ObjectId;
  userId: ObjectId;
  kind: SessionKind;
  /** SHA-256 of the opaque cookie value; the raw token is never stored */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type OtpPurpose = "phone_verification";

export type OtpChallengeDoc = {
  _id: ObjectId;
  userId: ObjectId;
  purpose: OtpPurpose;
  /** HMAC(AUTH_SECRET, challengeId, code) */
  codeHash: string;
  /** true for the one challenge per user and purpose that can still be used */
  active: boolean;
  attempts: number;
  expiresAt: Date;
  resendAvailableAt: Date;
  createdAt: Date;
  deliveredAt: Date | null;
  deliveryFailedAt: Date | null;
  consumedAt: Date | null;
  supersededAt: Date | null;
};

export type PasswordResetChannel = "sms" | "email";

export type PasswordResetDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /** SHA-256 of the token in the reset link */
  tokenHash: string;
  channel: PasswordResetChannel;
  createdAt: Date;
  expiresAt: Date;
  deliveredAt: Date | null;
  deliveryFailedAt: Date | null;
  usedAt: Date | null;
  supersededAt: Date | null;
};

export type FarmDoc = {
  _id: ObjectId;
  ownerUserId: ObjectId;
  /** the profile created during sign-up; at most one per owner */
  initialProfile: boolean;
  farmName: string;
  location: string;
  farmType: FarmType;
  birdCount: number;
  yearsOfExperience: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Where the current avatar is stored: a re-encoded WebP on Cloudinary. */
export type ProfilePhotoRef = {
  /** Cloudinary public id, used to delete the file once it's replaced */
  publicId: string;
  /** https delivery URL */
  url: string;
  width: number;
  height: number;
  updatedAt: Date;
};

/**
 * A service a user offers under Services & Pricing. Only the owner's id is
 * kept here; names, photos and other profile details stay on the user.
 */
export type ServiceDoc = {
  _id: ObjectId;
  ownerUserId: ObjectId;
  name: string;
  /** a value from SERVICE_CATEGORIES for the owner's role */
  category: string;
  description: string;
  /** whole naira; 0 means free */
  priceNgn: number;
  /** null when the duration varies */
  durationMinutes: number | null;
  active: boolean;
  /** only counts while the service is active */
  bookingAvailable: boolean;
  /** set when the owner removes the service; it's then hidden everywhere */
  archivedAt: Date | null;
  /**
   * Other Services marketplace categories only (docs/other-services.md);
   * absent on every other service. A "quote" service has priceNgn 0.
   */
  pricing?: ServicePricing;
  serviceStates?: NigerianState[];
  included?: string;
  excluded?: string;
  requirements?: string;
  /** directory search: words of the name, description and category (marketplace only) */
  searchWords?: string[];
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A bank account a user set up to receive payouts, one document per setup
 * attempt. The full account number is never stored: only its last four
 * digits and a keyed hash (to compare with later checks). Paystack's
 * recipient code is the reference future transfers will use.
 *
 * At most one document per owner is `current`, and only once its recipient
 * has been created. Replaced and failed attempts are kept as an audit trail.
 */
export type PayoutAccountDoc = {
  _id: ObjectId;
  ownerUserId: ObjectId;
  bankCode: string;
  bankName: string;
  accountNumberLast4: string;
  /** HMAC(AUTH_SECRET, bank code, account number) */
  accountFingerprint: string;
  /** as returned by Paystack's account resolution, never from the browser */
  accountName: string;
  status: PayoutAccountStatus;
  /** Paystack transfer recipient code, set once the recipient exists */
  recipientCode: string | null;
  /** the account payouts will go to; true only with status recipient_created */
  current: boolean;
  resolvedAt: Date;
  recipientCreatedAt: Date | null;
  failedAt: Date | null;
  /** set when a newer account took its place */
  replacedAt: Date | null;
  replacedBy: ObjectId | null;
  /** true when, on becoming current, it took the place of an earlier account (absent on older records) */
  replacedPrevious?: boolean;
  /**
   * Set in the same write as any change that notifies someone; cleared once
   * those notifications exist. The notification job retries any that stay
   * set (see lib/server/notifications.ts). Absent on records made earlier.
   */
  notifySyncAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A short-lived, single-use record of a successful account resolution,
 * linking the "check" and "confirm" steps. The browser only holds a random
 * token (stored here hashed); the account details stay on the server.
 */
export type BankVerificationDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /** SHA-256 of the token given to the browser */
  tokenHash: string;
  bankCode: string;
  bankName: string;
  /** HMAC(AUTH_SECRET, bank code, account number) */
  accountFingerprint: string;
  accountNumberLast4: string;
  accountName: string;
  /** true for the one check per user that can still be confirmed */
  active: boolean;
  createdAt: Date;
  expiresAt: Date;
  /** set while a confirmation is being processed, so it can't run twice */
  claimedAt: Date | null;
  consumedAt: Date | null;
  supersededAt: Date | null;
};

export type RateLimitDoc = {
  /** HMAC of scope + subject + window, so no raw IPs or identifiers are kept */
  _id: string;
  count: number;
  expiresAt: Date;
};

// --- wallet & earnings -------------------------------------------------------

export type LedgerSource = { type: EarningSourceType; id: string };

/**
 * One immutable line of the financial ledger, the only record balances are
 * derived from. Entries are only ever inserted, never updated or deleted;
 * a correction is a new, compensating entry. `amountKobo` is always a
 * positive integer: what it does to each balance is decided by `type` (see
 * ENTRY_EFFECTS in lib/server/ledger.ts).
 */
export type LedgerEntryDoc = {
  _id: ObjectId;
  userId: ObjectId;
  type: LedgerEntryType;
  amountKobo: number;
  currency: Currency;
  /** the order or booking an earning, fee or refund belongs to */
  source: LedgerSource | null;
  /** the payout a hold, release or paid entry belongs to */
  payoutId: ObjectId | null;
  /** the confirmed payment an earning came from */
  paymentReference: string | null;
  /** the refund a refund entry records */
  refundId: string | null;
  /** unique: the same event can never be recorded twice */
  idempotencyKey: string;
  /** per user, increasing in the order entries were written (pagination) */
  sequence: number;
  createdAt: Date;
};

/**
 * Delivery and dispute state of an order or booking: the trusted record of
 * when it was delivered, which starts the 24-hour settlement window.
 * `deliveredAt` is set once and never moved.
 */
export type FulfillmentDoc = {
  _id: ObjectId;
  sourceType: EarningSourceType;
  sourceId: string;
  deliveredAt: Date | null;
  /** set while a dispute is open; its earnings can't be withdrawn */
  disputedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Not a balance: a per-user lock and entry counter. Every ledger write for a
 * user increments it inside the same transaction, so two concurrent writes
 * (e.g. two payout requests) conflict and are run one after the other, each
 * seeing the other's entries.
 */
export type WalletAccountDoc = {
  _id: ObjectId;
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PayoutHistoryItem = { status: PayoutStatus; at: Date; by: "user" | "processor" | "webhook" | "reconciliation" };

/** A merchant-initiated payout to their verified Paystack recipient. */
export type PayoutDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /** sent by the browser, unique per user: a resubmission returns this payout */
  idempotencyKey: string;
  amountKobo: number;
  currency: Currency;
  status: PayoutStatus;
  /** the account it goes to, as it was when requested (never sent to the browser) */
  payoutAccountId: ObjectId;
  recipientCode: string;
  bankName: string;
  accountNumberLast4: string;
  /** the transfer reference sent to Paystack: fkp_<payout id> */
  reference: string;
  transferCode: string | null;
  /** last status Paystack reported, or "unknown" after an ambiguous call */
  providerStatus: string | null;
  failureReason: PayoutFailureReason | null;
  /** something needs a person to look at it (e.g. success reported after a failure) */
  issue: string | null;
  /** set when the transfer was sent to Paystack; it's never sent twice */
  transferInitiatedAt: Date | null;
  lastCheckedAt: Date | null;
  requestedAt: Date;
  processingAt: Date | null;
  paidAt: Date | null;
  failedAt: Date | null;
  history: PayoutHistoryItem[];
  /**
   * Set in the same write as any change that notifies someone; cleared once
   * those notifications exist. The notification job retries any that stay
   * set (see lib/server/notifications.ts). Absent on records made earlier.
   */
  notifySyncAt?: Date | null;
  /** how many history items have been turned into notifications */
  notifiedThrough?: number;
  createdAt: Date;
  updatedAt: Date;
};

/** A Paystack webhook that was applied, so a redelivery is recognised. */
export type ProviderEventDoc = {
  /** SHA-256 of the raw body */
  _id: string;
  event: string;
  reference: string | null;
  receivedAt: Date;
};

// --- market, orders & payments -------------------------------------------------

/** A poultry farmer's product listing. Stock is decremented when it's ordered. */
export type ProductDoc = {
  _id: ObjectId;
  sellerUserId: ObjectId;
  name: string;
  category: ProductCategory;
  description: string;
  unit: ProductUnit;
  priceKobo: number;
  /** units left to sell; never negative */
  stockQuantity: number;
  active: boolean;
  /** set when the seller removes it; kept for the orders that refer to it */
  archivedAt: Date | null;
  /**
   * Where the produce is (or is picked up from), as chosen by the seller.
   * Listings from before locations existed have neither field and are
   * treated as "location not given": they still appear everywhere except
   * under an explicit state filter.
   */
  state?: NigerianState | null;
  area?: string;
  /**
   * Photos, main one first (at most PRODUCT_PHOTO_RULES.maxPhotos). The
   * bytes are at Cloudinary; publicId is always one the server generated.
   * Absent on listings made before photos existed.
   */
  images?: ProductImageDoc[];
  /** absent on older listings, which are pickup only (DEFAULT_FULFILLMENT) */
  fulfillment?: ProductFulfillment;
  /**
   * Derived search data, never set from a request:
   * - searchTerms: the category's name and the everyday words for it
   *   (catalog.ts), so "broilers" finds live birds;
   * - ratingCount / ratingAverage: the product's published reviews, kept in
   *   step whenever one of its reviews changes and rebuildable from the
   *   reviews (`npm run db:rebuild-search`). ratingGen orders concurrent
   *   refreshes so an older count can't overwrite a newer one.
   */
  searchTerms?: string;
  ratingCount?: number;
  ratingAverage?: number | null;
  ratingGen?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductImageDoc = {
  /** our own id for the photo, used in API paths */
  id: string;
  publicId: string;
  url: string;
  width: number;
  height: number;
  addedAt: Date;
};

/** What was bought, as priced on the server when the order was placed. */
export type OrderItemDoc = {
  productId: ObjectId;
  name: string;
  unit: ProductUnit;
  unitPriceKobo: number;
  quantity: number;
  /** unit price × quantity, before any promotion */
  lineTotalKobo: number;
  /** this line's share of the order's promotion discount; absent on orders without one */
  discountKobo?: number;
};

/**
 * The promotion an order used, copied when the order was placed so later
 * edits, pauses or deletions of the promotion never change the order.
 */
export type OrderPromotionDoc = {
  promotionId: ObjectId;
  /** the promotion's version that was priced */
  version: number;
  name: string;
  code: string | null;
  type: PromotionType;
  value: number;
  scope: PromotionScope;
  productIds: ObjectId[];
  minOrderKobo: number | null;
  maxDiscountKobo: number | null;
  eligibleSubtotalKobo: number;
  /** subtotalKobo − discountKobo = totalKobo */
  discountKobo: number;
};

export type OrderHistoryDoc = { event: OrderEventName; at: Date; by: OrderActor; userId: ObjectId | null };

/**
 * An order from one buyer to one seller. Payment and fulfilment are tracked
 * separately and only change through conditional updates in
 * lib/server/order-*.ts. `number` (FKO-…) is the order's public reference and
 * its source id in the ledger.
 */
export type OrderDoc = {
  _id: ObjectId;
  number: string;
  buyerUserId: ObjectId;
  sellerUserId: ObjectId;
  /** sent by the browser, unique per buyer: a resubmission returns this order */
  idempotencyKey: string;
  /** SHA-256 of the items, method and note, to tell a resubmission from a different order */
  requestHash: string;
  buyerName: string;
  sellerName: string;
  items: OrderItemDoc[];
  /** the items at their listed prices */
  subtotalKobo: number;
  /** what the buyer pays: the subtotal less any promotion discount */
  totalKobo: number;
  /** the seller's promotion this order used; absent or null when none */
  promotion?: OrderPromotionDoc | null;
  currency: Currency;
  deliveryNote: string;
  /**
   * The chosen method and each product's details as they were when the
   * order was placed. Absent on orders placed before fulfilment options.
   */
  fulfillment?: {
    method: FulfillmentMethod;
    details: Array<{ productId: ObjectId; name: string; areas: string; timing: string; instructions: string }>;
  };
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  /** the reference of the payment that paid it */
  paymentReference: string | null;
  paidKobo: number;
  /** refunds Paystack has confirmed */
  refundedKobo: number;
  /** the refund being processed, if any (one at a time per order) */
  refundInFlight: ObjectId | null;
  refundPendingKobo: number;
  /** stock is taken when the order is placed and given back at most once */
  inventory: { reservedAt: Date; expiresAt: Date; releasedAt: Date | null };
  paidAt: Date | null;
  processingAt: Date | null;
  shippedAt: Date | null;
  /** server time when the seller marked it delivered; starts the 24-hour window */
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: OrderActor | null;
  cancelReason: string | null;
  issue: {
    reportedAt: Date;
    note: string;
    closedAt: Date | null;
    /**
     * Support's internal note, written once with the close and never shown
     * to the buyer or seller. Absent when closed by the internal job endpoint
     * or before the admin area existed.
     */
    resolution?: { note: string; byUserId: ObjectId; at: Date };
  } | null;
  /**
   * The commission applied when the seller's earning was recorded. null
   * until then (including while no commission policy is configured).
   */
  settlement: { policyId: string; rateBps: number; grossKobo: number; feeKobo: number; settledAt: Date } | null;
  /**
   * Set whenever a change still has to be reflected in the seller's ledger
   * (payment, delivery, refund, issue); cleared once the ledger matches. The
   * job retries any that stay set.
   */
  ledgerSyncAt: Date | null;
  /** something needs a person to look at it (e.g. a payment for the wrong amount) */
  reviewIssue: string | null;
  history: OrderHistoryDoc[];
  /**
   * Set in the same write as any change that notifies someone; cleared once
   * those notifications exist. The notification job retries any that stay
   * set (see lib/server/notifications.ts). Absent on records made earlier.
   */
  notifySyncAt?: Date | null;
  /** how many history items have been turned into notifications */
  notifiedThrough?: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * - initializing: being created at Paystack (outcome unknown until it answers)
 * - open: the buyer has a checkout link
 * - success / failed: Paystack's final answer
 * - superseded: never reached the buyer; replaced by a new attempt
 * - closed: the order was cancelled before it was paid
 */
export type PaymentAttemptStatus = "initializing" | "open" | "success" | "failed" | "superseded" | "closed";

/** One attempt to collect an order's total through Paystack. */
export type PaymentDoc = {
  _id: ObjectId;
  orderId: ObjectId;
  buyerUserId: ObjectId;
  /** fko_<payment id>: the Paystack transaction reference */
  reference: string;
  amountKobo: number;
  currency: Currency;
  status: PaymentAttemptStatus;
  /** true while the attempt can still be paid; at most one per order */
  active: boolean;
  authorizationUrl: string | null;
  providerStatus: string | null;
  providerTransactionId: number | null;
  paidAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * - creating: sent to Paystack, outcome unknown until it answers or is found
 * - pending: Paystack accepted it and is processing it
 * - processed / failed: Paystack's final answer
 */
export type RefundStatus = "creating" | "pending" | "processed" | "failed";

/**
 * Money returned to a buyer through Paystack. "order" refunds come out of
 * the order's paid total (and the seller's earning); "late_payment" returns a
 * payment that arrived after its order was closed and never counted.
 */
export type RefundDoc = {
  _id: ObjectId;
  orderId: ObjectId;
  kind: "order" | "late_payment";
  /** fkr_<refund id>: our reference, also the ledger refund id */
  reference: string;
  paymentReference: string;
  amountKobo: number;
  currency: Currency;
  reason: string;
  requestedBy: OrderActor;
  requestedByUserId: ObjectId | null;
  /** from the seller's refund form, unique per order */
  idempotencyKey: string | null;
  status: RefundStatus;
  providerRefundId: number | null;
  providerStatus: string | null;
  sentAt: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// --- reviews ---------------------------------------------------------------------

/**
 * A customer's review of a product they bought. One per customer per
 * product (a unique index); this collection is the only record of ratings,
 * and every average or count shown is computed from it. The reviewer, seller,
 * order and verifiedPurchase are set on the server when it's created and
 * never change; edits only touch rating, text, editedAt and updatedAt.
 */
export type ReviewDoc = {
  _id: ObjectId;
  productId: ObjectId;
  sellerUserId: ObjectId;
  reviewerUserId: ObjectId;
  /** the delivered order the review rests on */
  orderId: ObjectId;
  /** the position of the product in that order's items (items have no id of their own) */
  orderItemIndex: number;
  /** a whole number from 1 to 5 */
  rating: number;
  text: string;
  status: ReviewStatus;
  /** derived from a paid, delivered order; an edit never sets it */
  verifiedPurchase: boolean;
  editedAt: Date | null;
  withdrawnAt: Date | null;
  /** the last moderation decision; its reason lives only in the audit trail */
  moderation?: { action: "publish" | "reject" | "remove" | "restore"; at: Date };
  /**
   * Set in the same write as any change that notifies someone; cleared once
   * those notifications exist. The notification job retries any that stay
   * set (see lib/server/notifications.ts). Absent on records made earlier.
   */
  notifySyncAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// --- notifications ---------------------------------------------------------------

/**
 * One entry in a user's inbox. Only short, safe text is kept: never an
 * address, phone number, bank detail, payment payload or secret. `eventKey`
 * names the business event it came from; with the recipient it's unique, so
 * the same event can never notify the same person twice. Kept until the
 * account is removed (there's no automatic expiry).
 */
export type NotificationDoc = {
  _id: ObjectId;
  recipientUserId: ObjectId;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  /** an internal path checked by safeInternalPath, or null */
  url: string | null;
  /** e.g. order:<id>:<history index>:<event> */
  eventKey: string;
  /** what it's about, for support; ids only */
  subject: {
    kind: "order" | "payout" | "review" | "bank_account" | "account" | "appointment" | "service_booking";
    id: string;
  };
  /** when the business event happened */
  eventAt: Date;
  readAt: Date | null;
  createdAt: Date;
};

export type DeliveryState =
  | "pending"
  | "sending"
  | "sent"
  | "retryable_failure"
  | "failed"
  | "exhausted"
  | "skipped";

/**
 * The outbox: one external delivery (email, SMS or push) of a notification.
 * Created with the notification and sent later by the notification job,
 * never inside a database transaction. The inbox entry never depends on it.
 */
export type NotificationDeliveryDoc = {
  _id: ObjectId;
  notificationId: ObjectId;
  recipientUserId: ObjectId;
  channel: ExternalChannel;
  state: DeliveryState;
  attempts: number;
  /** when it may next be claimed (pending / retryable_failure only) */
  nextAttemptAt: Date | null;
  /** set while a worker holds it; a claim older than the lease is recovered */
  claimToken: ObjectId | null;
  claimedAt: Date | null;
  providerMessageId: string | null;
  /** a short failure category such as http_503 or not_configured; never content or contact details */
  lastFailure: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A user's channel choices per category. Missing means the defaults. */
export type NotificationPreferencesDoc = {
  /** the user's id */
  _id: ObjectId;
  categories: NotificationPreferences;
  updatedAt: Date;
};

/** A browser that opted in to push notifications for this user. */
export type PushSubscriptionDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /** SHA-256 of the endpoint, for lookups */
  endpointHash: string;
  /** the push service URL; a capability, so never logged or returned */
  endpoint: string;
  keys: { p256dh: string; auth: string };
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// --- admin & support -------------------------------------------------------------

/**
 * One admin action, written in the same transaction as the change it
 * records, so neither exists without the other. Append-only: nothing in the
 * app updates or deletes these. Holds ids, statuses and the admin's own
 * reason or note only; never secrets, bank details or copies of documents.
 */
export type AdminAuditDoc = {
  _id: ObjectId;
  /** the admin; null for the internal job endpoint (ORDER_JOB_SECRET) */
  actorUserId: ObjectId | null;
  action: AdminAction;
  target: { type: AuditTargetType; id: string };
  reason: string | null;
  from: string | null;
  to: string | null;
  at: Date;
};

// --- promotions ----------------------------------------------------------------------

/**
 * A seller's sale or coupon code. Funded by that seller: it only ever lowers
 * the price of their own products. Every change bumps `version`, and an
 * order is only placed against the version it was priced with.
 */
export type PromotionDoc = {
  _id: ObjectId;
  sellerUserId: ObjectId;
  name: string;
  description: string;
  type: PromotionType;
  /** whole percent, or kobo */
  value: number;
  scope: PromotionScope;
  /** empty when scope is "all" */
  productIds: ObjectId[];
  /** normalized (trimmed, uppercased) and unique; null for an automatic sale */
  code: string | null;
  startsAt: Date;
  endsAt: Date;
  minOrderKobo: number | null;
  maxDiscountKobo: number | null;
  totalLimit: number | null;
  perBuyerLimit: number | null;
  status: PromotionStatus;
  version: number;
  /** uses held by unpaid orders plus uses by paid ones; released uses are subtracted */
  redemptionCount: number;
  history: Array<{ event: "created" | "edited" | "activated" | "paused" | "ended"; at: Date }>;
  createdAt: Date;
  updatedAt: Date;
};

export type RedemptionStatus = "reserved" | "redeemed" | "released";

/**
 * One order's use of a promotion. Reserved when the order is placed,
 * redeemed when it is paid, released if it is cancelled or expires; one per
 * order (a unique index).
 */
export type PromotionRedemptionDoc = {
  _id: ObjectId;
  promotionId: ObjectId;
  sellerUserId: ObjectId;
  buyerUserId: ObjectId;
  orderId: ObjectId;
  orderNumber: string;
  status: RedemptionStatus;
  discountKobo: number;
  eligibleSubtotalKobo: number;
  /** what the buyer pays for the order */
  totalKobo: number;
  reservedAt: Date;
  redeemedAt: Date | null;
  releasedAt: Date | null;
};

// --- find a vet ------------------------------------------------------------------

/**
 * A veterinarian's booking settings (one per vet, `_id` = their user id).
 * `listed` is the vet's own choice to appear in Find a Vet; they're only
 * shown while their credential is also verified (see vet-directory.ts).
 */
export type VetAvailabilityDoc = {
  _id: ObjectId;
  listed: boolean;
  state: NigerianState | null;
  /** town or area they cover, free text */
  area: string;
  hours: WeeklyHours;
  slotMinutes: SlotMinutes;
  blockedDates: string[];
  sharePhoneWithClients: boolean;
  /** when the directory entry was last rebuilt from this and the other sources */
  directoryRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The searchable directory entry for one vet (`_id` = their user id). Derived
 * entirely from users, services and vet_availability, and rebuilt whenever
 * one of those changes (and by the appointment job), so it can always be
 * recreated. Holds public details only. Pages and bookings re-check the
 * sources; this is only used to find vets.
 */
export type VetDirectoryDoc = {
  _id: ObjectId;
  /** verified credential, active account, listing turned on, hours set, a bookable service */
  listed: boolean;
  name: string;
  /** lower-case name, for the A–Z sort */
  nameKey: string;
  photoUrl: string | null;
  specialization: string | null;
  yearsOfExperience: number | null;
  /** yearsOfExperience, or -1 when not given (sorts last) */
  experienceKey: number;
  state: NigerianState | null;
  area: string;
  serviceCategories: string[];
  priceFromNgn: number | null;
  /** minutes the shortest bookable service blocks (for the next open slot on cards) */
  minBlockMinutes: number;
  slotMinutes: SlotMinutes;
  hours: WeeklyHours;
  /** lower-case words from the name, specialization, service types and area */
  searchWords: string[];
  workDays: number[];
  blockedDates: string[];
  refreshedAt: Date;
};

export type AppointmentHistoryDoc = {
  status: BookingStatus;
  by: AppointmentActor;
  userId: ObjectId | null;
  at: Date;
  /** the customer's or vet's own short reason, when they gave one */
  note: string | null;
};

/**
 * The vet's record of a visit, created when it starts. The checklist is a
 * snapshot of the template for the service category at that moment, so a
 * later template change never rewrites a visit. The notes are private to
 * the assigned vet. See docs/vet-job-workflow.md.
 */
export type AppointmentVisitDoc = {
  template: { category: string; version: number };
  checklist: { id: string; label: string; required: boolean; doneAt: Date | null; doneBy: ObjectId | null }[];
  vaccineDetails: boolean;
  notes: VisitNotes;
  /** +1 on each save; a save must name the version it was based on */
  notesVersion: number;
  notesUpdatedAt: Date | null;
  notesUpdatedBy: ObjectId | null;
  createdAt: Date;
};

/**
 * One booking of a vet's service. The service, price and farm location are
 * copied in when it's made, so later edits never change it. Booking and
 * payment have separate statuses; payment is never collected in the app yet
 * (see docs/find-vet.md), so it is "not_required" or "payment_required".
 */
export type AppointmentDoc = {
  _id: ObjectId;
  /** short reference shown to both parties, e.g. VA-7K2M9QXC */
  reference: string;
  customerUserId: ObjectId;
  vetUserId: ObjectId;
  serviceId: ObjectId;
  service: { name: string; category: string; durationMinutes: number | null };
  startsAt: Date;
  endsAt: Date;
  location: { farmId: ObjectId | null; farmName: string; address: string; state: NigerianState; directions: string };
  price: { priceKobo: number; feeKobo: number; totalKobo: number; currency: "NGN" };
  bookingStatus: BookingStatus;
  paymentStatus: AppointmentPaymentStatus;
  respondBy: Date;
  idempotencyKey: string;
  history: AppointmentHistoryDoc[];
  /** set with the in_progress / completed transitions; absent on older appointments (use history) */
  startedAt?: Date | null;
  completedAt?: Date | null;
  /** absent until the visit starts, and on visits started before visit records existed */
  visit?: AppointmentVisitDoc | null;
  /** the slot holds were deleted (declined, cancelled or lapsed) */
  slotsReleasedAt: Date | null;
  /** see NotificationDoc: set with each change that notifies someone */
  notifySyncAt: Date | null;
  notifiedThrough: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * One 30-minute unit of a vet's time held by an appointment. Unique per vet
 * and start time, so two bookings can never hold the same unit; inserted in
 * the same transaction as the appointment and deleted when it's declined,
 * cancelled or lapses.
 */
export type AppointmentSlotDoc = {
  _id: ObjectId;
  vetUserId: ObjectId;
  startsAt: Date;
  appointmentId: ObjectId;
  createdAt: Date;
};

// --- Other Services bookings (docs/other-services.md) ---------------------------------

export type ServiceBookingHistoryDoc = {
  event: ServiceBookingEvent;
  by: ServiceBookingActor;
  userId: ObjectId | null;
  at: Date;
  /** the customer's or provider's own short reason, when they gave one */
  note: string | null;
};

/**
 * One booking of a marketplace service. The service's name, category and
 * pricing are copied in when it's made, so later edits never change it; the
 * customer comes from the session and the provider from the service.
 * `status` is the booking's progress and `paymentStatus` its money: a
 * booking is only ever paid in full and only ever refunded in full.
 */
export type ServiceBookingDoc = {
  _id: ObjectId;
  /** shown to both parties, e.g. FK-SVC-7K2M9QXC */
  reference: string;
  customerUserId: ObjectId;
  providerUserId: ObjectId;
  serviceId: ObjectId;
  service: { name: string; category: MarketplaceCategory; pricing: ServicePricing; durationMinutes: number | null };
  details: BookingDetails;
  schedule: { date: string; window: TimeWindow };
  location: { address: string; state: NigerianState; directions: string };
  contactPreference: ContactPreference;
  notes: string;
  status: ServiceBookingStatus;
  /** the price agreed in kobo: the service's price (fixed) or the accepted quote; null before that */
  amountKobo: number | null;
  quote: { amountKobo: number; note: string; offeredAt: Date; validUntil: Date } | null;
  paymentStatus: ServicePaymentStatus;
  /** what Paystack confirmed for the paying attempt (0 until then) */
  paidKobo: number;
  paymentReference: string | null;
  paidAt: Date | null;
  refundedKobo: number;
  /** the refund being sent, while one is */
  refundInFlight: ObjectId | null;
  /** the provider accepted the job (or offered the quote the customer accepted) */
  acceptedAt: Date | null;
  completedAt: Date | null;
  /** an unanswered request lapses at this time */
  respondBy: Date | null;
  /** an unpaid booking lapses at this time */
  payBy: Date | null;
  /**
   * `<serviceId>:<date>` while the booking is open, null once it's finished:
   * unique per customer, so the same service can't be booked twice for one day
   */
  openKey: string | null;
  idempotencyKey: string;
  history: ServiceBookingHistoryDoc[];
  /** the commission applied to the provider's earning, fixed once */
  settlement: { policyId: string; rateBps: number; grossKobo: number; feeKobo: number; settledAt: Date } | null;
  ledgerSyncAt: Date | null;
  /** see NotificationDoc: set with each change that notifies someone */
  notifySyncAt: Date | null;
  notifiedThrough: number;
  /** why a person needs to look at it (a payment or refund that didn't add up) */
  reviewIssue: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** One attempt to collect a booking's price through Paystack (see PaymentDoc). */
export type ServicePaymentDoc = {
  _id: ObjectId;
  bookingId: ObjectId;
  customerUserId: ObjectId;
  /** fsp_<payment id>: the Paystack transaction reference */
  reference: string;
  amountKobo: number;
  currency: Currency;
  status: PaymentAttemptStatus;
  /** at most one per booking (a unique index) */
  active: boolean;
  authorizationUrl: string | null;
  providerStatus: string | null;
  providerTransactionId: number | null;
  paidAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Money returned to a customer for a booking (see RefundDoc). "booking"
 * refunds return the whole payment when a paid booking is declined,
 * cancelled or lapses; "late_payment" returns a payment that arrived after
 * the booking stopped waiting for one.
 */
export type ServiceRefundDoc = {
  _id: ObjectId;
  bookingId: ObjectId;
  kind: "booking" | "late_payment";
  /** fsr_<refund id>: our reference, also the ledger refund id */
  reference: string;
  paymentReference: string;
  amountKobo: number;
  currency: Currency;
  reason: string;
  status: RefundStatus;
  providerRefundId: number | null;
  providerStatus: string | null;
  sentAt: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// --- Korret Academy (docs/training-academy.md) -------------------------------------

export type CourseResourceDoc = {
  /** issued by the server, never changes */
  id: string;
  title: string;
  /** a validated Cloudinary PDF delivery URL */
  url: string;
};

export type CourseLessonDoc = {
  /** issued by the server and kept through every edit, so progress records stay attached */
  id: string;
  title: string;
  summary: string;
  durationSeconds: number;
  /** a validated Cloudinary video delivery URL; null while not added */
  videoUrl: string | null;
  resources: CourseResourceDoc[];
};

export type CourseModuleDoc = { id: string; title: string; lessons: CourseLessonDoc[] };

/**
 * A course, its curriculum embedded in order (bounded by TRAINING_LIMITS).
 * Drafts are only ever read by the admin area.
 */
export type CourseDoc = {
  _id: ObjectId;
  status: CourseStatus;
  title: string;
  description: string;
  instructor: string;
  category: CourseCategory;
  difficulty: Difficulty;
  objectives: string[];
  prerequisites: string[];
  coverUrl: string | null;
  /** shown under "Featured" on the Training home while published; set by an admin */
  featured: boolean;
  modules: CourseModuleDoc[];
  /** derived from modules on every save */
  lessonCount: number;
  durationSeconds: number;
  /** lower-case word prefixes of title, category and instructor */
  searchWords: string[];
  /** when it was last published; the catalogue's order. null while never published */
  publishedAt: Date | null;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

/** One per learner and course, created when they start it. */
export type CourseEnrollmentDoc = {
  _id: ObjectId;
  userId: ObjectId;
  courseId: ObjectId;
  enrolledAt: Date;
  /** the lesson they last opened or saved a position in */
  lastLessonId: string | null;
  lastActivityAt: Date;
  /** the first time every lesson of the curriculum then current was complete; kept as history */
  completedAt: Date | null;
};

/** One per learner, course and lesson. Kept when a lesson is removed or a course unpublished. */
export type LessonProgressDoc = {
  _id: ObjectId;
  userId: ObjectId;
  courseId: ObjectId;
  lessonId: string;
  positionSeconds: number;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A person a farm owner has invited to train. Matched to an account only by
 * the invitee accepting while signed in with the invited (verified) phone.
 */
export type FarmStaffDoc = {
  _id: ObjectId;
  farmId: ObjectId;
  ownerUserId: ObjectId;
  /** E.164 */
  phoneNormalized: string;
  role: StaffRole;
  status: StaffStatus;
  /** true while invited or active: at most one open record per farm and phone */
  open?: true;
  /** set when they accept */
  userId: ObjectId | null;
  invitedAt: Date;
  respondedAt: Date | null;
  removedAt: Date | null;
  updatedAt: Date;
};

/** The published courses a farm assigns to everyone in one staff role. */
export type TrainingProgramDoc = {
  _id: ObjectId;
  farmId: ObjectId;
  role: StaffRole;
  courseIds: ObjectId[];
  updatedBy: ObjectId;
  updatedAt: Date;
};
