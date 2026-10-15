import type { BankAccountResponse, ConfirmResponse } from "@/lib/bank-details/types";
import { assertSameOrigin, ok, readJsonBody, route, tooManyRequests } from "@/lib/server/http";
import {
  BANK_DETAILS_UNVERIFIED,
  confirmAccount,
  findCurrentAccount,
  parseConfirmRequest,
  toSummary,
  type ConfirmMode,
} from "@/lib/server/payout-accounts";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in user's payout account. The owner always comes from the
// session — there's no user id in the URL or body — and the account name
// always comes from Paystack, via the verification created by
// POST /api/bank-details/resolve.
//
// There's deliberately no DELETE yet: removing the account payouts go to is
// a decision for the payouts milestone.

export const GET = route("bank-details", async (request) => {
  const { user } = await requireVerifiedRequest(request, BANK_DETAILS_UNVERIFIED);
  const account = await findCurrentAccount(user._id);
  return ok<BankAccountResponse>({ account: account ? toSummary(account) : null });
});

const confirm = (mode: ConfirmMode) =>
  route("bank-details", async (request) => {
    assertSameOrigin(request);
    const { user } = await requireVerifiedRequest(request, BANK_DETAILS_UNVERIFIED);
    const limit = await hit("bankAccountSavesPerUser", user._id.toHexString());
    if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);

    const input = parseConfirmRequest(await readJsonBody(request));
    const account = await confirmAccount(user._id, mode, input);
    return ok<ConfirmResponse>({ account }, { status: mode === "add" ? 201 : 200 });
  });

/** Saves the user's first payout account. */
export const POST = confirm("add");

/** Replaces the current payout account; the old one stays until this succeeds. */
export const PATCH = confirm("replace");
