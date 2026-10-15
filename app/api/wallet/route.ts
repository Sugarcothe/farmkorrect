import type { WalletResponse } from "@/lib/wallet/types";
import { ok, route, tooManyRequests } from "@/lib/server/http";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { getWalletOverview, WALLET_UNVERIFIED } from "@/lib/server/wallet";

// The signed-in user's balances (derived from the ledger), latest
// transactions and the masked account payouts go to.

export const GET = route("wallet", async (request) => {
  const { user } = await requireVerifiedRequest(request, WALLET_UNVERIFIED);
  const limit = await hit("walletReadsPerUser", user._id.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);
  return ok<WalletResponse>(await getWalletOverview(user._id));
});
