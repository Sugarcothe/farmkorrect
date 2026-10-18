import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { TRAINING_UNVERIFIED } from "@/lib/server/training";
import { setProgram } from "@/lib/server/training-staff";
import type { ProgramResponse } from "@/lib/training/types";

// Sets the published courses ({courseIds}) assigned to one staff role on the
// signed-in owner's own farm.

type Context = { params: Promise<{ role: string }> };

export const PUT = route<Context>("training/program", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("staffChangesPerUser", user._id);
  const program = await setProgram(user, (await params).role, await readJsonBody(request));
  return ok<ProgramResponse>({ program });
});
