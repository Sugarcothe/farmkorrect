import type { OrderResponse, OrdersResponse } from "@/lib/orders/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { toOrder, toOrderSummary } from "@/lib/server/order-store";
import { createOrder, listOrders, parseOrderRequest } from "@/lib/server/orders";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { PAGE_SIZE, parsePage } from "@/lib/server/wallet";

// GET: the signed-in user's orders as a buyer, or (?as=seller) the orders
// they received as a seller. POST: places an order. Only product ids,
// quantities, a delivery note and an idempotency key are accepted: prices,
// the seller and the total are decided here from the database.

export const GET = route("orders", async (request) => {
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const params = new URL(request.url).searchParams;
  const as = params.get("as") ?? "buyer";
  if (as !== "buyer" && as !== "seller") throw new HttpError(400, "Unknown view.", { as: "Use buyer or seller." });
  const page = parsePage(params);
  await limitUser("orderReadsPerUser", user._id);
  const { orders, hasMore } = await listOrders(user._id, as, { page, pageSize: PAGE_SIZE });
  return ok<OrdersResponse>({ orders: orders.map((o) => toOrderSummary(o, as)), page, hasMore });
});

export const POST = route("orders", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const input = parseOrderRequest(await readJsonBody(request));
  await limitUser("orderCreatesPerUser", user._id, "Too many orders placed. Please wait a while and try again.");
  const { order, created } = await createOrder(user, input);
  return ok<OrderResponse>({ order: toOrder(order, "buyer") }, { status: created ? 201 : 200 });
});
