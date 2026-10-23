import type { TeamMemberDetail } from "@/lib/admin/accounts";
import { requireAdminCapability } from "@/lib/server/admin";
import { changeRole, getTeamMember, MEMBER_NOT_FOUND, parseRoleChange } from "@/lib/server/admin-team";
import { HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// One account's admin role: GET shows it with its history; POST changes or
// revokes it ({action: "change", role, reason, expectedVersion} or
// {action: "revoke", reason, expectedVersion}).

type Context = { params: Promise<{ userId: string }> };

export const GET = route<Context>("admin/team", async (request, { params }) => {
  const access = await requireAdminCapability(request, "admin.team.manage");
  await limitUser("adminReadsPerUser", access.user._id);
  const found = await getTeamMember((await params).userId);
  if (!found) throw new HttpError(404, MEMBER_NOT_FOUND);
  return ok<TeamMemberDetail>(found);
});

export const POST = route<Context>("admin/team", async (request, { params }) => {
  const access = await requireAdminCapability(request, "admin.team.manage", { mutation: true });
  await limitUser("adminActionsPerUser", access.user._id);
  const input = parseRoleChange(await readJsonBody(request));
  return ok<TeamMemberDetail>(await changeRole(access, (await params).userId, input));
});
