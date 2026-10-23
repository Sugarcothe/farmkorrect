import type { CaseListResponse, CaseResponse } from "@/lib/admin/cases";
import { requireAdminCapability } from "@/lib/server/admin";
import { countCases, createCase, listCases, parseCaseFilters, parseCreateCase } from "@/lib/server/admin-cases";
import { ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// The case centre. GET lists cases (?state=open|closed, status, type,
// priority, assignee=me|none|<id>, page) with the open counts; POST opens a
// case about a flagged record ({type, sourceId, priority?, title?, note?}).
// Opening a case never changes the record it's about.

export const GET = route("admin/cases", async (request) => {
  const access = await requireAdminCapability(request, "admin.cases.read");
  const params = new URL(request.url).searchParams;
  const filters = parseCaseFilters(params);
  const page = parsePage(params);
  await limitUser("adminReadsPerUser", access.user._id);
  const [list, counts] = await Promise.all([listCases(access, filters, page), countCases(access)]);
  return ok<CaseListResponse>({ ...list, counts });
});

export const POST = route("admin/cases", async (request) => {
  const access = await requireAdminCapability(request, ["admin.cases.manage", "admin.cases.assign"], {
    mutation: true,
  });
  await limitUser("adminActionsPerUser", access.user._id);
  const input = parseCreateCase(await readJsonBody(request));
  return ok<CaseResponse>(await createCase(access, input));
});
