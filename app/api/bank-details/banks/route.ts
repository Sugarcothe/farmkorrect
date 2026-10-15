import type { BanksResponse } from "@/lib/bank-details/types";
import { ok, route } from "@/lib/server/http";
import { BANK_DETAILS_UNVERIFIED, supportedBanks } from "@/lib/server/payout-accounts";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// Nigerian banks that can receive transfers, from Paystack (cached on the
// server for a few hours). Signed-in users only, so this can't be used as an
// open proxy to Paystack.

export const GET = route("bank-details/banks", async (request) => {
  await requireVerifiedRequest(request, BANK_DETAILS_UNVERIFIED);
  const banks = await supportedBanks();
  return ok<BanksResponse>({ banks: banks.map(({ code, name }) => ({ code, name })) });
});
