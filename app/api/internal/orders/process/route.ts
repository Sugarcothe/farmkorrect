import { ok, route } from "@/lib/server/http";
import { requireOrderJobSecret } from "@/lib/server/order-access";
import { runOrderJob } from "@/lib/server/order-jobs";

// Called by a scheduler (e.g. a cron job every few minutes) with an
// "Authorization: Bearer <ORDER_JOB_SECRET>" header: cancels unpaid orders
// whose reservation ran out, settles payments and refunds whose outcome
// isn't known yet, and retries ledger updates (including settling paid
// orders once a commission policy is configured). Not reachable at all
// while ORDER_JOB_SECRET is unset.

export const POST = route("internal/orders/process", async (request) => {
  requireOrderJobSecret(request);
  return ok(await runOrderJob());
});
