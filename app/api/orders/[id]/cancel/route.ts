import type { OrderResponse } from "@/lib/orders/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { toOrder } from "@/lib/server/order-store";
import { cancelOrder, parseReason, requireOrder } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The buyer cancels their order before the seller has accepted it. Stock is
// given back, and a paid order is refunded in full.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("orders/cancel", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const reason = parseReason(await readJsonBody(request), false);
  await limitUser("orderActionsPerUser", user._id);
  const order = await requireOrder(user._id, (await params).id, "buyer");
  const cancelled = await cancelOrder(order, { by: "buyer", userId: user._id }, reason);
  return ok<OrderResponse>({ order: toOrder(cancelled, "buyer") });
});
