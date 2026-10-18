import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { TRAINING_UNVERIFIED } from "@/lib/server/training";
import { changeStaffRole, removeStaff } from "@/lib/server/training-staff";

// One invitation or staff member on the signed-in owner's own farm.
// PATCH {role}: moves them to another role. DELETE: withdraws the invitation
// or removes them (the record is closed, not deleted). Anything on another
// farm is a 404.

type Context = { params: Promise<{ id: string }> };

export const PATCH = route<Context>("training/staff/member", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("staffChangesPerUser", user._id);
  await changeStaffRole(user, (await params).id, await readJsonBody(request));
  return ok({ updated: true });
});

export const DELETE = route<Context>("training/staff/member", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("staffChangesPerUser", user._id);
  await removeStaff(user, (await params).id);
  return ok({ removed: true });
});
