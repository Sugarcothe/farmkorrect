// Shapes the Market, Orders and Sales API sends and accepts. Amounts are
// integer kobo in NGN. Prices, totals, sellers, stock and every status are
// decided on the server: the browser only ever sends product ids,
// quantities, a fulfilment choice, a delivery note, an optional coupon code
// and an idempotency key.
// Farm Korret never adds a delivery fee: any delivery charge is agreed
// between buyer and seller, outside the app.

import type { NigerianState } from "@/lib/locations/nigeria";
import type { OrderPromotion, ProductOffer } from "@/lib/promotions/types";
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
  /** town, area or LGA shown next to the state */
  area: { max: 60 },
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

/** Product photos: stored at Cloudinary as WebP; only references are kept here. */
export const PRODUCT_PHOTO_RULES = {
  maxBytes: 8 * 1024 * 1024,
  maxPhotos: 5,
  types: ["image/jpeg", "image/png", "image/webp"],
} as const;

/** How a buyer gets the goods. Both are arranged by the seller; there's no courier. */
export const FULFILLMENT_METHODS = [
  { value: "pickup", label: "Pickup" },
  { value: "delivery", label: "Seller-arranged delivery" },
] as const;

export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number]["value"];

export const FULFILLMENT_LIMITS = {
  instructions: { max: 300 },
  /** where the seller delivers to (e.g. "Ikeja, Yaba and Surulere") */
  areas: { min: 3, max: 200 },
  /** e.g. "Within 2 days of payment" */
  timing: { max: 120 },
} as const;

export type ProductFulfillment = {
  pickup: { enabled: boolean; instructions: string };
  delivery: { enabled: boolean; areas: string; timing: string; instructions: string };
};

/** Listings made before fulfilment options existed are pickup only. */
export const DEFAULT_FULFILLMENT: ProductFulfillment = {
  pickup: { enabled: true, instructions: "" },
  delivery: { enabled: false, areas: "", timing: "", instructions: "" },
};

export const NO_DELIVERY_FEE_NOTICE =
  "Farm Korret doesn't calculate or collect delivery fees. Any delivery charge is agreed directly between you and the seller.";

export type ProductImage = { id: string; url: string; width: number; height: number };

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
  /** where the produce is, or is picked up from; null when the seller hasn't said */
  state: NigerianState | null;
  /** optional town, area or LGA within the state ("" when not given) */
  area: string;
  /** at least one method is always enabled */
  fulfillment: ProductFulfillment;
};

/** One of the signed-in seller's own listings. */
export type Product = ProductFields & {
  id: string;
  /** the first is the main photo; empty when there are none */
  images: ProductImage[];
  createdAt: string;
  updatedAt: string;
};

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
  /** null when the seller hasn't given a location */
  state: NigerianState | null;
  area: string;
  /** from published reviews only; null when there are none */
  rating: { average: number; count: number } | null;
  /** the first is the main photo (Market results carry only that one) */
  images: ProductImage[];
  fulfillment: ProductFulfillment;
  /** the seller's live automatic sale on it, if any; the order is priced again at checkout */
  offer: ProductOffer | null;
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
  /** this line's share of the order's discount (0 when none) */
  discountKobo: number;
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

/**
 * How the buyer chose to get the goods, as the seller described it when the
 * order was placed (one entry per product). Later edits to the listing don't
 * change it. Choosing delivery isn't proof anything was sent: that's still
 * the fulfilment status.
 */
export type OrderFulfillment = {
  method: FulfillmentMethod;
  details: Array<{ productId: string; name: string; areas: string; timing: string; instructions: string }>;
};

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
  /** the seller's promotion, taken off the subtotal (0 when none) */
  discountKobo: number;
  /** the promotion as it was when the order was placed; null when none */
  promotion: OrderPromotion | null;
  /** what the buyer pays: the subtotal less any discount (no delivery fee or tax is added) */
  totalKobo: number;
  currency: Currency;
  deliveryNote: string;
  /** null for orders placed before fulfilment options existed */
  fulfillment: OrderFulfillment | null;
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
  /** must be enabled on every product in the order */
  fulfillmentMethod: FulfillmentMethod;
  deliveryNote: string;
  /** random UUID made once per checkout, so a resubmit returns the same order */
  idempotencyKey: string;
  /** the total the buyer saw; the order is refused if prices changed since */
  expectedTotalKobo?: number;
  /** a seller's coupon code; replaces any automatic sale (one offer per order) */
  couponCode?: string;
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
