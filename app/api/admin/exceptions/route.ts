import { isExceptionKind, type ExceptionPage } from "@/lib/admin/types";
import { requireAdminRequest } from "@/lib/server/admin";
import { listExceptions } from "@/lib/server/admin-queues";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// Read-only operational exceptions: ?kind=orders (default), payouts or
// deliveries. Nothing here changes payments, payouts, refunds or the ledger.

export const GET = route("admin/exceptions", async (request) => {
  const { user } = await requireAdminRequest(request);
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") ?? "orders";
  if (!isExceptionKind(kind))
    throw new HttpError(400, "Please correct the filters.", { kind: "Choose orders, payouts or deliveries." });
  const page = parsePage(params);
  await limitUser("adminReadsPerUser", user._id);
  return ok<ExceptionPage>(await listExceptions(kind, page));
});
