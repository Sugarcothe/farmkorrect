import { request } from "@/lib/auth/api";
import type {
  CheckoutResponse,
  FulfillmentAction,
  OrderRequest,
  OrderResponse,
  ProductFields,
  ProductResponse,
  VerifyPaymentResponse,
} from "./types";

// Browser-side calls for the Market, the buyer's orders and the seller's
// sales. The session cookie identifies who is acting; no user id, price,
// total or status is ever sent. Payment is only ever confirmed by the
// server checking with Paystack.

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const product = (id: string) => `/api/products/${encodeURIComponent(id)}`;
const order = (id: string) => `/api/orders/${encodeURIComponent(id)}`;
const sale = (id: string) => `/api/sales/${encodeURIComponent(id)}`;

export type ProductUpdateRequest = Partial<ProductFields> & { expectedStockQuantity?: number };

export const createProduct = (body: ProductFields) => request<ProductResponse>("/api/products", json("POST", body));
export const updateProduct = (id: string, body: ProductUpdateRequest) =>
  request<ProductResponse>(product(id), json("PATCH", body));
export const archiveProduct = (id: string) => request<null>(product(id), { method: "DELETE" });

export const placeOrder = (body: OrderRequest) => request<OrderResponse>("/api/orders", json("POST", body));
export const startCheckout = (id: string) => request<CheckoutResponse>(`${order(id)}/checkout`, json("POST", {}));
export const verifyPayment = (id: string, reference: string | null) =>
  request<VerifyPaymentResponse>(`${order(id)}/verify-payment`, json("POST", reference ? { reference } : {}));
export const cancelOrder = (id: string, reason: string) =>
  request<OrderResponse>(`${order(id)}/cancel`, json("POST", reason ? { reason } : {}));
export const reportIssue = (id: string, note: string) => request<OrderResponse>(`${order(id)}/issue`, json("POST", { note }));

export const fulfilSale = (id: string, action: FulfillmentAction) =>
  request<OrderResponse>(`${sale(id)}/fulfillment`, json("POST", { action }));
export const cancelSale = (id: string, reason: string) => request<OrderResponse>(`${sale(id)}/cancel`, json("POST", { reason }));
export const refundSale = (id: string, body: { amountKobo: number; reason: string; idempotencyKey: string }) =>
  request<OrderResponse>(`${sale(id)}/refund`, json("POST", body));
