import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { TRAINING_UNVERIFIED } from "@/lib/server/training";
import { listInvitations } from "@/lib/server/training-staff";
import type { StaffInvitation } from "@/lib/training/types";

// Staff invitations sent to the signed-in user's own verified phone number.

export const GET = route("training/invitations", async (request) => {
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("trainingReadsPerUser", user._id);
  return ok<{ invitations: StaffInvitation[] }>({ invitations: await listInvitations(user) });
});
