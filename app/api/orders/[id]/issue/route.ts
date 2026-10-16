import type { OrderResponse } from "@/lib/orders/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { toOrder } from "@/lib/server/order-store";
import { parseIssue, reportIssue, requireOrder } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The buyer reports a problem within 24 hours of delivery; the seller's
// earning from the order is held until it's resolved.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("orders/issue", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const note = parseIssue(await readJsonBody(request));
  await limitUser("orderActionsPerUser", user._id);
  const order = await requireOrder(user._id, (await params).id, "buyer");
  return ok<OrderResponse>({ order: toOrder(await reportIssue(order, user._id, note), "buyer") });
});
