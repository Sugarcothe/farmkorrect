import { HttpError, ok, readJsonBody, route, str } from "@/lib/server/http";
import { requireOrderJobSecret } from "@/lib/server/order-access";
import { closeIssue } from "@/lib/server/orders";

// Support closes a problem a buyer reported, once it's resolved (with a
// refund from the seller first, if one was due). Takes the order number;
// the seller's earning is released from review. Protected like the job.

export const POST = route("internal/orders/issues", async (request) => {
  requireOrderJobSecret(request);
  const number = str(await readJsonBody(request), "orderNumber");
  if (!/^FKO-[A-Z0-9]{8}$/.test(number)) throw new HttpError(400, "Invalid order number.");
  const order = await closeIssue(number);
  if (!order) throw new HttpError(404, "No open issue for that order.");
  return ok({ orderNumber: order.number, closed: true });
});
