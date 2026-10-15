import { request } from "@/lib/auth/api";
import type { PayoutRequest, PayoutResponse } from "./types";

// Browser-side calls for the signed-in user's wallet. Only an amount and an
// idempotency key are ever sent: balances and the destination account are
// decided by the server.

export const requestPayout = (body: PayoutRequest) =>
  request<PayoutResponse>("/api/payouts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
