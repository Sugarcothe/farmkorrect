import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { TRAINING_UNVERIFIED } from "@/lib/server/training";
import { getStaffOverview, inviteStaff } from "@/lib/server/training-staff";
import type { StaffMemberResponse, StaffOverview } from "@/lib/training/types";

// Staff Training for the signed-in farm owner's own farm (from the session;
// no farm id is accepted). GET: programmes and staff with their progress.
// POST {phone, role}: invites someone, who must accept before anything is shared.

export const GET = route("training/staff", async (request) => {
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("trainingReadsPerUser", user._id);
  return ok<StaffOverview>(await getStaffOverview(user));
});

export const POST = route("training/staff", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("staffChangesPerUser", user._id);
  const member = await inviteStaff(user, await readJsonBody(request));
  return ok<StaffMemberResponse>({ member }, { status: 201 });
});
