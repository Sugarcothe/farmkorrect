import type { ResolveResponse } from "@/lib/bank-details/types";
import { assertSameOrigin, ok, readJsonBody, route, tooManyRequests } from "@/lib/server/http";
import { BANK_DETAILS_UNVERIFIED, checkAccount, parseResolveRequest } from "@/lib/server/payout-accounts";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// Checks an account number with Paystack and returns the registered name,
// plus a short-lived, single-use verification to confirm it with. Nothing
// is saved as the user's bank account here.

export const POST = route("bank-details/resolve", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, BANK_DETAILS_UNVERIFIED);
  const input = parseResolveRequest(await readJsonBody(request));
  // counted after the format checks, so only real lookups use up attempts
  const limit = await hit("bankResolvesPerUser", user._id.toHexString());
  if (limit.limited)
    throw tooManyRequests(limit.retryAfterSeconds, "Too many account checks. Please wait a while and try again.");

  const verification = await checkAccount(user._id, input);
  return ok<ResolveResponse>({ verification });
});
