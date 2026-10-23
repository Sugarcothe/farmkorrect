import type { CaseResponse } from "@/lib/admin/cases";
import { requireAdminCapability } from "@/lib/server/admin";
import { changeCase, getCase, parseCaseChange } from "@/lib/server/admin-cases";
import { ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// One case: GET shows it with its notes, a live summary of its source and
// its history; POST makes one change against the version the admin saw
// ({action, expectedVersion, ...}): assign, priority, status, note,
// resolve, dismiss or reopen. A stale version is a 409.

type Context = { params: Promise<{ reference: string }> };

export const GET = route<Context>("admin/cases", async (request, { params }) => {
  const access = await requireAdminCapability(request, "admin.cases.read");
  await limitUser("adminReadsPerUser", access.user._id);
  return ok<CaseResponse>(await getCase(access, (await params).reference));
});

export const POST = route<Context>("admin/cases", async (request, { params }) => {
  const access = await requireAdminCapability(request, ["admin.cases.manage", "admin.cases.assign"], {
    mutation: true,
  });
  await limitUser("adminActionsPerUser", access.user._id);
  const input = parseCaseChange(await readJsonBody(request));
  return ok<CaseResponse>(await changeCase(access, (await params).reference, input));
});
