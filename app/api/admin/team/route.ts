import type { TeamMemberDetail, TeamOverview } from "@/lib/admin/accounts";
import { requireAdminCapability } from "@/lib/server/admin";
import { getTeam, grantRole, parseGrant } from "@/lib/server/admin-team";
import { ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// The admin team (Super Admins only). GET lists who holds which role; POST
// grants a role to an existing account ({userId, role, reason}), found first
// through /api/admin/team/lookup. There are no invitations and no account
// creation here.

export const GET = route("admin/team", async (request) => {
  const access = await requireAdminCapability(request, "admin.team.manage");
  await limitUser("adminReadsPerUser", access.user._id);
  return ok<TeamOverview>(await getTeam());
});

export const POST = route("admin/team", async (request) => {
  const access = await requireAdminCapability(request, "admin.team.manage", { mutation: true });
  await limitUser("adminActionsPerUser", access.user._id);
  const input = parseGrant(await readJsonBody(request));
  return ok<TeamMemberDetail>(await grantRole(access, input));
});
