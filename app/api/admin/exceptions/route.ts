import { isExceptionKind, type ExceptionPage } from "@/lib/admin/types";
import { ADMIN_FORBIDDEN, requireAdminCapability } from "@/lib/server/admin";
import { listExceptions } from "@/lib/server/admin-queues";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// Read-only operational exceptions: ?kind=orders (default), bookings, payouts
// or deliveries. Nothing here changes payments, payouts, refunds or the
// ledger. Money exceptions need admin.exceptions.read; failed deliveries
// need admin.deliveries.read.

export const GET = route("admin/exceptions", async (request) => {
  const access = await requireAdminCapability(request, ["admin.exceptions.read", "admin.deliveries.read"]);
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") ?? (access.can("admin.exceptions.read") ? "orders" : "deliveries");
  if (!isExceptionKind(kind))
    throw new HttpError(400, "Please correct the filters.", { kind: "Choose orders, bookings, payouts or deliveries." });
  if (!access.can(kind === "deliveries" ? "admin.deliveries.read" : "admin.exceptions.read"))
    throw new HttpError(403, ADMIN_FORBIDDEN);
  const page = parsePage(params);
  await limitUser("adminReadsPerUser", access.user._id);
  return ok<ExceptionPage>(await listExceptions(kind, page));
});
