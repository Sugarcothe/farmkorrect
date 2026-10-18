import { MIN_PAYABLE_KOBO, type PromotionScope, type PromotionType } from "./types";

// The discount arithmetic, shared by the server (which decides every price)
// and the seller's preview. Integer kobo only: percentages round down, so a
// buyer is never promised more than the seller set, and the discount never
// exceeds the eligible products, the cap, or the order less ₦1.

export type PricingRule = {
  type: PromotionType;
  value: number;
  scope: PromotionScope;
  productIds: readonly string[];
  minOrderKobo: number | null;
  maxDiscountKobo: number | null;
};

export type PricingLine = { productId: string; lineTotalKobo: number };

export type Discount = {
  eligibleSubtotalKobo: number;
  discountKobo: number;
  /** per order line, in order; 0 for lines the promotion doesn't cover */
  lineDiscounts: number[];
};

export type NotApplicable =
  | { reason: "no_eligible_items" }
  | { reason: "below_minimum"; minOrderKobo: number; eligibleSubtotalKobo: number }
  | { reason: "no_saving" };

/**
 * Splits `discount` across lines in proportion to their totals. Each share is
 * rounded down, then the leftover kobo go one each to the lines with the
 * largest remainders (earlier lines first on ties), so shares add up exactly
 * and none exceeds its line.
 */
export function allocate(discount: number, totals: readonly number[]): number[] {
  const sum = totals.reduce((a, b) => a + b, 0);
  if (discount <= 0 || sum <= 0) return totals.map(() => 0);
  if (discount > sum) throw new RangeError("A discount can't exceed the lines it's split across.");
  // BigInt keeps discount × line exact for any amount the app accepts
  const shares = totals.map((t) => {
    const scaled = BigInt(discount) * BigInt(t);
    return { share: Number(scaled / BigInt(sum)), rest: Number(scaled % BigInt(sum)) };
  });
  let left = discount - shares.reduce((a, s) => a + s.share, 0);
  const order = shares.map((s, i) => ({ i, rest: s.rest })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    if (shares[i].share < totals[i]) {
      shares[i].share++;
      left--;
    }
  }
  return shares.map((s) => s.share);
}

/** What `rule` takes off an order made of `lines`, or why it doesn't apply. */
export function applyPromotion(rule: PricingRule, lines: readonly PricingLine[]): Discount | NotApplicable {
  const covered = new Set(rule.productIds);
  const eligible = lines.map((l) => rule.scope === "all" || covered.has(l.productId));
  const eligibleTotals = lines.map((l, i) => (eligible[i] ? l.lineTotalKobo : 0));
  const eligibleSubtotalKobo = eligibleTotals.reduce((a, b) => a + b, 0);
  if (eligibleSubtotalKobo === 0) return { reason: "no_eligible_items" };
  if (rule.minOrderKobo !== null && eligibleSubtotalKobo < rule.minOrderKobo)
    return { reason: "below_minimum", minOrderKobo: rule.minOrderKobo, eligibleSubtotalKobo };

  const subtotal = lines.reduce((a, l) => a + l.lineTotalKobo, 0);
  const raw =
    rule.type === "percentage"
      ? Number((BigInt(eligibleSubtotalKobo) * BigInt(rule.value)) / BigInt(100))
      : rule.value;
  const discountKobo = Math.min(
    raw,
    rule.maxDiscountKobo ?? Number.MAX_SAFE_INTEGER,
    eligibleSubtotalKobo,
    subtotal - MIN_PAYABLE_KOBO,
  );
  if (discountKobo <= 0) return { reason: "no_saving" };
  const shares = allocate(discountKobo, eligibleTotals);
  return { eligibleSubtotalKobo, discountKobo, lineDiscounts: shares };
}

export const isDiscount = (result: Discount | NotApplicable): result is Discount => "discountKobo" in result;
