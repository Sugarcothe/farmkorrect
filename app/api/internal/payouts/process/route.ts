import { createHash, timingSafeEqual } from "node:crypto";
import { getPayoutJobSecret } from "@/lib/server/config";
import { HttpError, ok, route } from "@/lib/server/http";
import { runPayoutJob } from "@/lib/server/payouts";

// Called by a scheduler (e.g. a cron job every few minutes) with an
// "Authorization: Bearer <PAYOUT_JOB_SECRET>" header: sends payouts whose
// background send didn't run and settles ones whose outcome isn't known yet.
// Not reachable at all while PAYOUT_JOB_SECRET is unset.

const digest = (value: string) => createHash("sha256").update(value).digest();

export const POST = route("internal/payouts/process", async (request) => {
  const secret = getPayoutJobSecret();
  if (!secret) throw new HttpError(404, "Not found.");
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // compared as fixed-length digests, in constant time
  if (!given || !timingSafeEqual(digest(given), digest(secret))) throw new HttpError(401, "Not authorized.");
  return ok(await runPayoutJob());
});
