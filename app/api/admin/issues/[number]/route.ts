import type { IssueCaseResponse } from "@/lib/admin/types";
import { ADMIN_NOT_FOUND, requireAdminCapability } from "@/lib/server/admin";
import { closeIssueAsAdmin, getIssueCase, parseCloseIssue } from "@/lib/server/admin-queues";
import { HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// One reported order issue: GET shows it with its history; POST closes it
// ({note, confirmed: true}). Closing releases the seller's held earning
// through the ledger; it never refunds the buyer.

type Context = { params: Promise<{ number: string }> };

export const GET = route<Context>("admin/issues", async (request, { params }) => {
  const { user } = await requireAdminCapability(request, "admin.order_issues.read");
  await limitUser("adminReadsPerUser", user._id);
  const found = await getIssueCase((await params).number);
  if (!found) throw new HttpError(404, ADMIN_NOT_FOUND);
  return ok<IssueCaseResponse>(found);
});

export const POST = route<Context>("admin/issues", async (request, { params }) => {
  const { user } = await requireAdminCapability(request, "admin.order_issues.resolve", { mutation: true });
  await limitUser("adminActionsPerUser", user._id);
  const note = parseCloseIssue(await readJsonBody(request));
  const { number } = await params;
  await closeIssueAsAdmin(user, number, note);
  const found = await getIssueCase(number);
  if (!found) throw new HttpError(404, ADMIN_NOT_FOUND);
  return ok<IssueCaseResponse>(found);
});
