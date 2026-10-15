// Shapes the Wallet & Earnings API sends and accepts. Every amount is an
// integer number of kobo (₦1 = 100 kobo) in NGN; nothing is ever a float.
// Balances are always derived on the server from the ledger: the browser
// never sends a balance, entry or status, only a payout amount and an
// idempotency key.

export const CURRENCY = "NGN";
export type Currency = typeof CURRENCY;

/** Earnings become withdrawable this long after the delivery is confirmed. */
export const SETTLEMENT_DELAY_MS = 24 * 60 * 60_000;

/** Smallest payout a user can request (₦100). */
export const MIN_PAYOUT_KOBO = 100_00;

export type WalletSummary = {
  currency: Currency;
  /** can be withdrawn now */
  availableKobo: number;
  /** paid for, but not yet delivered or still inside the 24-hour window */
  pendingKobo: number;
  /** earnings on hold while an issue with the order is looked into */
  underReviewKobo: number;
  /** set aside for payouts that are being processed */
  heldKobo: number;
  /** sent to the user's bank */
  paidOutKobo: number;
  /**
   * More was refunded than was left to withdraw (e.g. a refund after a
   * payout). It's taken from future earnings; availableKobo is then 0.
   */
  owedKobo: number;
  /** when the next pending earning becomes available, if one is scheduled */
  nextAvailableAt: string | null;
};

export type LedgerEntryType =
  | "earning"
  | "platform_fee"
  | "refund"
  | "payout_hold"
  | "payout_release"
  | "payout_paid";

/**
 * From the user's point of view: credits add to what they can withdraw,
 * debits take from it, and "none" moves money between their own buckets
 * (a payout that was already deducted when it was requested being sent).
 */
export type Direction = "credit" | "debit" | "none";

export type EarningStatus = "awaiting_delivery" | "pending" | "available" | "under_review" | "refunded";

export type PayoutStatus = "requested" | "processing" | "paid" | "failed";

export type WalletTransaction = {
  id: string;
  type: LedgerEntryType;
  direction: Direction;
  amountKobo: number;
  description: string;
  /** the order or booking, or the payout, the entry belongs to */
  reference: string;
  /** current status of that earning or payout */
  status: EarningStatus | PayoutStatus | null;
  createdAt: string;
};

export type EarningSourceType = "order" | "service_booking";

export type Earning = {
  sourceType: EarningSourceType;
  reference: string;
  grossKobo: number;
  feesKobo: number;
  refundedKobo: number;
  netKobo: number;
  status: EarningStatus;
  deliveredAt: string | null;
  /** deliveredAt + 24 hours; null until delivery is confirmed */
  availableAt: string | null;
  createdAt: string;
};

export type PayoutFailureReason =
  | "provider_rejected"
  | "provider_failed"
  | "provider_reversed"
  | "not_found_at_provider"
  | "account_changed"
  | "transfers_misconfigured";

export type Payout = {
  id: string;
  reference: string;
  amountKobo: number;
  currency: Currency;
  status: PayoutStatus;
  bankName: string;
  accountNumberLast4: string;
  failureReason: PayoutFailureReason | null;
  requestedAt: string;
  paidAt: string | null;
  failedAt: string | null;
};

/** The masked account payouts go to, or null when none is ready. */
export type PayoutDestination = { bankName: string; accountNumberLast4: string };

export type WalletResponse = {
  summary: WalletSummary;
  recent: WalletTransaction[];
  destination: PayoutDestination | null;
  /** false while payouts haven't been switched on for the platform */
  payoutsEnabled: boolean;
};

export type TransactionFilter = "all" | "credits" | "debits" | "earnings" | "payouts";

export type TransactionsResponse = {
  transactions: WalletTransaction[];
  /** pass as `before` to get the next (older) page; null on the last page */
  nextCursor: string | null;
};

export type EarningsResponse = { earnings: Earning[]; page: number; hasMore: boolean };

export type PayoutsResponse = { payouts: Payout[]; page: number; hasMore: boolean };

export type PayoutRequest = {
  amountKobo: number;
  /** random UUID made once per payout form, so a resubmit returns the same payout */
  idempotencyKey: string;
};

export type PayoutResponse = { payout: Payout };
