import type { CheckoutResponse } from "@/lib/orders/types";
import { assertSameOrigin, ok, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { checkout } from "@/lib/server/order-payments";
import { requireOrder } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// Starts (or resumes) paying for the buyer's order. Returns only Paystack's
// checkout link and our reference; the amount is the order's stored total
// and the email is the buyer's own. Nothing is paid until it's verified.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("orders/checkout", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  await limitUser("orderActionsPerUser", user._id);
  const order = await requireOrder(user._id, (await params).id, "buyer");
  return ok<CheckoutResponse>(await checkout(order, user));
});
