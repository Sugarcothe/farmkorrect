import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { TRAINING_UNVERIFIED } from "@/lib/server/training";
import { parseDecision, respondToInvitation } from "@/lib/server/training-staff";
import type { InvitationResponse } from "@/lib/training/types";

// Accepts or declines ({decision}) an invitation sent to the signed-in user's
// own verified phone number. Anyone else's invitation is a 404.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("training/invitation", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("staffChangesPerUser", user._id);
  const decision = parseDecision(await readJsonBody(request));
  return ok<InvitationResponse>(await respondToInvitation(user, (await params).id, decision));
});
