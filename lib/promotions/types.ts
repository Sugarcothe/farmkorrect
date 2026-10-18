// Public shapes for seller promotions (sales and coupon codes). Every
// discount is funded by the seller who created it: it lowers what the buyer
// pays for that seller's own products and nothing else. Amounts are integer
// kobo throughout.

export type PromotionType = "percentage" | "fixed";
/** what the seller last chose; see PromotionState for what buyers see */
export type PromotionStatus = "draft" | "active" | "paused" | "ended";
/** every one of the seller's products, or the listed ones */
export type PromotionScope = "all" | "products";

/**
 * Where a promotion stands right now, from its status, dates and limit:
 * only "live" promotions reduce prices.
 */
export type PromotionState = "draft" | "scheduled" | "live" | "paused" | "expired" | "used_up" | "ended";

export const PROMOTION_TYPES: ReadonlyArray<{ value: PromotionType; label: string }> = [
  { value: "percentage", label: "Percentage off" },
  { value: "fixed", label: "Amount off (₦)" },
];

export const PROMOTION_STATE_LABELS: Record<PromotionState, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  live: "Live",
  paused: "Paused",
  expired: "Expired",
  used_up: "Fully used",
  ended: "Ended",
};

export const PROMOTION_LIMITS = {
  name: { min: 3, max: 60 },
  description: { max: 300 },
  /** whole percent */
  percent: { min: 1, max: 90 },
  /** ₦1 to ₦10,000,000 */
  fixedKobo: { min: 100, max: 1_000_000_000 },
  products: { max: 50 },
  code: { min: 4, max: 20 },
  totalLimit: { max: 1_000_000 },
  perBuyerLimit: { max: 100 },
  /** how long one promotion can run */
  maxDays: 366,
  /** how far ahead one can be scheduled */
  maxLeadDays: 366,
} as const;

/** Letters, digits and single hyphens inside; stored and compared uppercased. */
export const COUPON_CODE = /^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){3,19}$/;

/** "  spring-10 " → "SPRING-10". Codes are matched only in this form. */
export const normalizeCouponCode = (value: string) => value.trim().toUpperCase();

/** At least this much is always paid, so an order is never free. */
export const MIN_PAYABLE_KOBO = 100;

export type PromotionFields = {
  name: string;
  description: string;
  type: PromotionType;
  /** whole percent for "percentage", kobo for "fixed" */
  value: number;
  scope: PromotionScope;
  /** the seller's own products; empty when scope is "all" */
  productIds: string[];
  /** a coupon code buyers must enter, or null for an automatic sale */
  code: string | null;
  /** ISO times */
  startsAt: string;
  endsAt: string;
  /** spent on eligible products */
  minOrderKobo: number | null;
  maxDiscountKobo: number | null;
  /** redemptions across all buyers */
  totalLimit: number | null;
  perBuyerLimit: number | null;
};

export type PromotionStats = {
  /** paid orders that used it */
  redeemedCount: number;
  /** placed and waiting for payment (they hold a use until paid or cancelled) */
  reservedCount: number;
  /** discount given on paid orders */
  discountKobo: number;
  /** what buyers paid on those orders, after the discount */
  paidKobo: number;
};

export type Promotion = PromotionFields & {
  id: string;
  status: PromotionStatus;
  state: PromotionState;
  /** sent back with edits and status changes, so stale ones are refused */
  version: number;
  /** uses held or redeemed now (released uses are given back) */
  redemptionCount: number;
  products: Array<{ id: string; name: string }>;
  stats: PromotionStats;
  createdAt: string;
  updatedAt: string;
};

export type PromotionAction = "activate" | "pause" | "end";

export type PromotionResponse = { promotion: Promotion };
export type PromotionsResponse = { promotions: Promotion[] };

/** An automatic sale shown on a Market listing. */
export type ProductOffer = {
  name: string;
  type: PromotionType;
  value: number;
  /** one unit's price after the offer, for percentage offers with no minimum; else null */
  salePriceKobo: number | null;
  minOrderKobo: number | null;
  maxDiscountKobo: number | null;
  endsAt: string;
};

/** The promotion an order used, as it was when the order was placed. */
export type OrderPromotion = {
  name: string;
  code: string | null;
  type: PromotionType;
  value: number;
  eligibleSubtotalKobo: number;
  discountKobo: number;
};

export type QuoteRequest = {
  items: Array<{ productId: string; quantity: number }>;
  couponCode?: string;
};

export type Quote = {
  subtotalKobo: number;
  discountKobo: number;
  totalKobo: number;
  promotion: OrderPromotion | null;
  /** why the entered code wasn't applied; the quote is then without it */
  couponError: string | null;
};

export type QuoteResponse = { quote: Quote };

/** "10% off" / "₦500.00 off". */
export function offerLabel(offer: { type: PromotionType; value: number }, format: (kobo: number) => string): string {
  return offer.type === "percentage" ? `${offer.value}% off` : `${format(offer.value)} off`;
}
