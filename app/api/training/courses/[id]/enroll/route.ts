import { assertSameOrigin, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { enroll, TRAINING_UNVERIFIED } from "@/lib/server/training";
import type { EnrollResponse } from "@/lib/training/types";

// Starts a published course for the signed-in learner. Idempotent: starting
// again returns the same enrolment and where to resume. No body is read.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("training/enroll", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("trainingProgressWritesPerUser", user._id);
  return ok<EnrollResponse>(await enroll(user._id, (await params).id));
});
