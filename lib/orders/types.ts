// Shapes the Market, Orders and Sales API sends and accepts. Amounts are
// integer kobo in NGN. Prices, totals, sellers, stock and every status are
// decided on the server: the browser only ever sends product ids,
// quantities, a delivery note and an idempotency key.

import type { Currency } from "@/lib/wallet/types";

export const PRODUCT_CATEGORIES = [
  { value: "live-birds", label: "Live birds" },
  { value: "eggs", label: "Eggs" },
  { value: "dressed-chicken", label: "Dressed chicken" },
  { value: "day-old-chicks", label: "Day-old chicks" },
  { value: "manure", label: "Poultry manure" },
  { value: "other", label: "Other farm produce" },
] as const;

export const PRODUCT_UNITS = [
  { value: "bird", label: "per bird" },
  { value: "crate", label: "per crate (30 eggs)" },
  { value: "kg", label: "per kg" },
  { value: "bag", label: "per bag" },
  { value: "piece", label: "per piece" },
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]["value"];
export type ProductUnit = (typeof PRODUCT_UNITS)[number]["value"];

export const PRODUCT_LIMITS = {
  name: { min: 3, max: 80 },
  description: { max: 600 },
  /** ₦1 to ₦10,000,000 per unit */
  priceKobo: { min: 100, max: 1_000_000_000 },
  stock: { max: 100_000 },
  perSeller: 50,
} as const;

export const ORDER_LIMITS = {
  items: 20,
  quantity: 1_000,
  deliveryNote: { min: 10, max: 300 },
  issueNote: { min: 10, max: 500 },
  refundReason: { min: 5, max: 200 },
} as const;

/** Unpaid orders hold their stock this long, then they're cancelled. */
export const RESERVATION_MS = 30 * 60_000;

export type ProductFields = {
  name: string;
  category: ProductCategory;
  description: string;
  unit: ProductUnit;
  priceKobo: number;
  stockQuantity: number;
  active: boolean;
};

/** One of the signed-in seller's own listings. */
export type Product = ProductFields & { id: string; createdAt: string; updatedAt: string };

/** A listing as buyers see it in the Market. */
export type MarketProduct = {
  id: string;
  name: string;
  category: ProductCategory;
  description: string;
  unit: ProductUnit;
  priceKobo: number;
  stockQuantity: number;
  sellerName: string;
  /** the signed-in user's own listing (they can't buy it) */
  own: boolean;
};

/**
 * Whether the buyer's money was received, kept apart from where the goods
 * are. "failed" only means the last attempt failed: the buyer may try again.
 */
export type PaymentStatus = "pending" | "paid" | "failed" | "cancelled" | "refunded" | "partially_refunded";

export type FulfillmentStatus = "pending" | "processing" | "in_transit" | "delivered" | "cancelled";

export type OrderItem = {
  productId: string;
  name: string;
  unit: ProductUnit;
  unitPriceKobo: number;
  quantity: number;
  lineTotalKobo: number;
};

export type OrderEventName =
  | "created"
  | "payment_started"
  | "payment_failed"
  | "paid"
  | "processing"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "expired"
  | "stock_released"
  | "refund_requested"
  | "refund_processed"
  | "refund_failed"
  | "late_payment_refunded"
  | "issue_reported"
  | "issue_closed";

export type OrderActor = "buyer" | "seller" | "system";

export type OrderEvent = { event: OrderEventName; at: string; by: OrderActor };

export type BuyerAction = "pay" | "cancel" | "report_issue";
export type SellerAction = "accept" | "ship" | "deliver" | "cancel" | "refund";

export type Order = {
  id: string;
  number: string;
  /** whose view this is */
  viewer: "buyer" | "seller";
  sellerName: string;
  buyerName: string;
  items: OrderItem[];
  subtotalKobo: number;
  /** what the buyer pays: the subtotal (no delivery fee or tax is added) */
  totalKobo: number;
  currency: Currency;
  deliveryNote: string;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  refundedKobo: number;
  /** a refund that's been requested but not yet confirmed by Paystack */
  refundPendingKobo: number;
  /** how much more can still be refunded */
  refundableKobo: number;
  /** unpaid orders are cancelled at this time */
  payBy: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelledBy: OrderActor | null;
  issue: { reportedAt: string; note: string; open: boolean } | null;
  /** buyers can report a problem until then (24 hours after delivery) */
  reportIssueUntil: string | null;
  actions: Array<BuyerAction | SellerAction>;
  history: OrderEvent[];
  createdAt: string;
};

export type OrderSummary = Pick<
  Order,
  "id" | "number" | "viewer" | "sellerName" | "buyerName" | "totalKobo" | "paymentStatus" | "fulfillmentStatus" | "createdAt"
> & { itemCount: number; firstItem: string };

export type OrderRequest = {
  items: Array<{ productId: string; quantity: number }>;
  deliveryNote: string;
  /** random UUID made once per checkout, so a resubmit returns the same order */
  idempotencyKey: string;
  /** the total the buyer saw; the order is refused if prices changed since */
  expectedTotalKobo?: number;
};

export type OrderResponse = { order: Order };
export type OrdersResponse = { orders: OrderSummary[]; page: number; hasMore: boolean };
export type ProductResponse = { product: Product };
export type ProductsResponse = { products: Product[] };

export type CheckoutResponse = { authorizationUrl: string; reference: string };

/**
 * The result of checking a payment with Paystack on the server:
 * - paid: Paystack confirmed it and the order is paid
 * - pending: not completed yet (or still being processed)
 * - failed: the attempt failed; the buyer can try again
 * - unknown: Paystack couldn't be reached; check again later
 */
export type PaymentCheck = "paid" | "pending" | "failed" | "unknown";

export type VerifyPaymentResponse = { result: PaymentCheck; order: Order };

export type FulfillmentAction = "accept" | "ship" | "deliver";
