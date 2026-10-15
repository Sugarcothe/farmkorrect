import { after } from "next/server";
import type { PayoutResponse, PayoutsResponse } from "@/lib/wallet/types";
import { assertSameOrigin, ok, readJsonBody, route, tooManyRequests } from "@/lib/server/http";
import { listPayouts, parsePayoutRequest, processPayout, requestPayout, toPublicPayout } from "@/lib/server/payouts";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { PAGE_SIZE, parsePage, WALLET_UNVERIFIED } from "@/lib/server/wallet";

// The signed-in user's payouts. POST only takes an amount and an
// idempotency key: the balance is checked, and the bank account chosen, on
// the server. The response is the payout as saved ("requested"); the
// transfer is sent afterwards, so a slow Paystack never holds up the request
// and a retried request can never send money twice.

export const GET = route("payouts", async (request) => {
  const { user } = await requireVerifiedRequest(request, WALLET_UNVERIFIED);
  const page = parsePage(new URL(request.url).searchParams);
  const limit = await hit("walletReadsPerUser", user._id.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);
  const { payouts, hasMore } = await listPayouts(user._id, { page, pageSize: PAGE_SIZE });
  return ok<PayoutsResponse>({ payouts, page, hasMore });
});

export const POST = route("payouts", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, WALLET_UNVERIFIED);
  const input = parsePayoutRequest(await readJsonBody(request));
  const limit = await hit("payoutRequestsPerUser", user._id.toHexString());
  if (limit.limited)
    throw tooManyRequests(limit.retryAfterSeconds, "Too many payout requests. Please wait a while and try again.");

  const { payout, created } = await requestPayout(user._id, input);
  if (created) {
    after(async () => {
      try {
        await processPayout(payout._id);
      } catch (error) {
        // the processing job picks it up again
        console.error(`[payouts] background processing failed: ${error instanceof Error ? error.name : "unknown"}`);
      }
    });
  }
  return ok<PayoutResponse>({ payout: toPublicPayout(payout) }, { status: created ? 201 : 200 });
});
