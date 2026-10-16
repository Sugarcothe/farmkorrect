import type { OrderResponse } from "@/lib/orders/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { toOrder } from "@/lib/server/order-store";
import { parseRefundRequest, refundOrder, requireOrder } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The seller refunds part or all of a delivered (or cancelled) order. The
// refund is sent through Paystack; the order and the seller's wallet only
// change once Paystack confirms it, and the earning is held meanwhile.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("sales/refund", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const input = parseRefundRequest(await readJsonBody(request));
  await limitUser("orderActionsPerUser", user._id);
  const order = await requireOrder(user._id, (await params).id, "seller");
  return ok<OrderResponse>({ order: toOrder(await refundOrder(order, user._id, input), "seller") });
});
