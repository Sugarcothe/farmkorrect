import type { OrderResponse } from "@/lib/orders/types";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { ORDER_NOT_FOUND, toOrder } from "@/lib/server/order-store";
import { findOrderFor } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// One order, for its buyer or its seller only; anyone else gets a 404.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("orders", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  await limitUser("orderReadsPerUser", user._id);
  const { id } = await params;
  const asBuyer = await findOrderFor(user._id, id, "buyer");
  if (asBuyer) return ok<OrderResponse>({ order: toOrder(asBuyer, "buyer") });
  const asSeller = await findOrderFor(user._id, id, "seller");
  if (asSeller) return ok<OrderResponse>({ order: toOrder(asSeller, "seller") });
  throw new HttpError(404, ORDER_NOT_FOUND);
});
