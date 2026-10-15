import type { TransactionsResponse } from "@/lib/wallet/types";
import { ok, route, tooManyRequests } from "@/lib/server/http";
import { listTransactions } from "@/lib/server/ledger";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parseTransactionQuery, WALLET_UNVERIFIED } from "@/lib/server/wallet";

// The signed-in user's ledger entries, newest first. Read-only: entries
// can't be edited or deleted through any route.

export const GET = route("wallet/transactions", async (request) => {
  const { user } = await requireVerifiedRequest(request, WALLET_UNVERIFIED);
  const query = parseTransactionQuery(new URL(request.url).searchParams);
  const limit = await hit("walletReadsPerUser", user._id.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);
  return ok<TransactionsResponse>(await listTransactions(user._id, query));
});
