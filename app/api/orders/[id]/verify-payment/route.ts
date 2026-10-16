import type { VerifyPaymentResponse } from "@/lib/orders/types";
import { assertSameOrigin, ok, readJsonBody, route, str } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { verifyOrderPayment } from "@/lib/server/order-payments";
import { toOrder } from "@/lib/server/order-store";
import { findOrderFor, requireOrder } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// Called when the buyer comes back from Paystack. Returning proves nothing:
// the payment is looked up with Paystack's verification API on the server,
// and the order is only marked paid if everything matches.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("orders/verify-payment", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const reference = str(await readJsonBody(request), "reference") || null;
  await limitUser("paymentChecksPerUser", user._id, "Too many payment checks. Please wait a few minutes.");
  const { id } = await params;
  const order = await requireOrder(user._id, id, "buyer");
  const result = await verifyOrderPayment(order, reference);
  const fresh = (await findOrderFor(user._id, id, "buyer")) ?? order;
  return ok<VerifyPaymentResponse>({ result, order: toOrder(fresh, "buyer") });
});
