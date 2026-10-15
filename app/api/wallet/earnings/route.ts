import type { EarningsResponse } from "@/lib/wallet/types";
import { ok, route, tooManyRequests } from "@/lib/server/http";
import { listEarnings } from "@/lib/server/ledger";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { PAGE_SIZE, parsePage, WALLET_UNVERIFIED } from "@/lib/server/wallet";

// The signed-in user's earnings, one row per order or booking.

export const GET = route("wallet/earnings", async (request) => {
  const { user } = await requireVerifiedRequest(request, WALLET_UNVERIFIED);
  const page = parsePage(new URL(request.url).searchParams);
  const limit = await hit("walletReadsPerUser", user._id.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);
  const { earnings, hasMore } = await listEarnings(user._id, { page, pageSize: PAGE_SIZE });
  return ok<EarningsResponse>({ earnings, page, hasMore });
});
