import { request } from "@/lib/auth/api";
import type { ReviewInput, ReviewResponse } from "./types";

// Browser-side calls for product reviews. The session cookie identifies the
// reviewer; only the rating and text are ever sent. Whether the review is
// allowed, which order it rests on and its status are decided by the server.

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const review = (id: string) => `/api/reviews/${encodeURIComponent(id)}`;

export const createReview = (productId: string, body: ReviewInput) =>
  request<ReviewResponse>(`/api/products/${encodeURIComponent(productId)}/reviews`, json("POST", body));
export const updateReview = (id: string, body: Partial<ReviewInput>) => request<ReviewResponse>(review(id), json("PATCH", body));
export const withdrawReview = (id: string) => request<ReviewResponse>(review(id), { method: "DELETE" });
