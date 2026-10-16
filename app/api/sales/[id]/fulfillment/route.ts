import type { OrderResponse } from "@/lib/orders/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { toOrder } from "@/lib/server/order-store";
import { fulfilOrder, isFulfillmentAction, requireOrder } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The seller moves a paid order along: accept → ship → deliver. Only the
// action is sent; each step's time is the server's, so the delivery time
// that starts the 24-hour settlement window can't be chosen.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("sales/fulfillment", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const body = await readJsonBody(request);
  const action = body.action;
  if (!isFulfillmentAction(action) || Object.keys(body).length !== 1)
    throw new HttpError(400, "Unknown action.", { action: "Use accept, ship or deliver." });
  await limitUser("orderActionsPerUser", user._id);
  const order = await requireOrder(user._id, (await params).id, "seller");
  return ok<OrderResponse>({ order: toOrder(await fulfilOrder(order, user._id, action), "seller") });
});
