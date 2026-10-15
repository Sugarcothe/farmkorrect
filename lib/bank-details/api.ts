import { request } from "@/lib/auth/api";
import type { BanksResponse, ConfirmRequest, ConfirmResponse, ResolveRequest, ResolveResponse } from "./types";

// Browser-side calls for the signed-in user's own payout account. The
// session cookie identifies the owner; no user id is ever sent, and every
// Paystack request is made by the server.

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getBanks = () => request<BanksResponse>("/api/bank-details/banks", { method: "GET" });

export const resolveAccount = (body: ResolveRequest) =>
  request<ResolveResponse>("/api/bank-details/resolve", json("POST", body));

/** Saves the first account (POST) or replaces the current one (PATCH). */
export const confirmAccount = (body: ConfirmRequest, replacing: boolean) =>
  request<ConfirmResponse>("/api/bank-details", json(replacing ? "PATCH" : "POST", body));
