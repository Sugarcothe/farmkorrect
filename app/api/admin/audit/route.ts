import type { AuditPage } from "@/lib/admin/types";
import { requireAdminRequest } from "@/lib/server/admin";
import { listAudit, parseAuditFilters } from "@/lib/server/admin-audit";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// The admin audit trail, newest first (?page=, ?action=, ?targetType=,
// ?targetId=, ?actor=). Read only: there is no way to edit or delete records.

export const GET = route("admin/audit", async (request) => {
  const { user } = await requireAdminRequest(request);
  const params = new URL(request.url).searchParams;
  const filters = parseAuditFilters(params);
  const page = parsePage(params);
  await limitUser("adminReadsPerUser", user._id);
  return ok<AuditPage>(await listAudit(filters, page));
});
