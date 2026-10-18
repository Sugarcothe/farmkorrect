import { request } from "@/lib/auth/api";
import type { PromotionAction, PromotionFields, PromotionResponse, QuoteRequest, QuoteResponse } from "./types";

// Browser-side calls for seller promotions and the checkout price. The
// session decides whose promotions these are; the server works out every
// discount itself, so nothing here can choose an amount.

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const promotion = (id: string) => `/api/promotions/${encodeURIComponent(id)}`;

export const createPromotion = (body: PromotionFields) => request<PromotionResponse>("/api/promotions", json("POST", body));
export const updatePromotion = (id: string, body: PromotionFields, expectedVersion: number) =>
  request<PromotionResponse>(promotion(id), json("PATCH", { ...body, expectedVersion }));
export const changePromotionStatus = (id: string, action: PromotionAction, expectedVersion: number) =>
  request<PromotionResponse>(`${promotion(id)}/status`, json("POST", { action, expectedVersion }));

export const quoteOrder = (body: QuoteRequest) => request<QuoteResponse>("/api/orders/quote", json("POST", body));
