import type { QuoteResponse } from "@/lib/promotions/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser, ORDERS_UNVERIFIED } from "@/lib/server/order-access";
import { parseQuoteRequest } from "@/lib/server/orders";
import { quoteOrder } from "@/lib/server/promotions";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// What an order would cost right now, with the seller's promotion (or the
// buyer's coupon code) applied: shown at checkout before the order is
// placed. Only product ids, quantities and a code are accepted; nothing is
// reserved, and placing the order prices it again from the database.

export const POST = route("orders", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, ORDERS_UNVERIFIED);
  const { items, couponCode } = parseQuoteRequest(await readJsonBody(request));
  await limitUser("orderQuotesPerUser", user._id, "Too many price checks. Please wait a few minutes and try again.");
  return ok<QuoteResponse>({ quote: await quoteOrder(user._id, items, couponCode) });
});
