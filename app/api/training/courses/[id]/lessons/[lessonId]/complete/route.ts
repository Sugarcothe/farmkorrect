import { assertSameOrigin, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { completeLesson, TRAINING_UNVERIFIED } from "@/lib/server/training";
import type { CompleteResponse } from "@/lib/training/types";

// Marks a lesson complete for the signed-in learner. Idempotent. The course's
// progress in the response is recalculated from their completion records;
// nothing about progress is read from the request.

type Context = { params: Promise<{ id: string; lessonId: string }> };

export const POST = route<Context>("training/complete", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("trainingProgressWritesPerUser", user._id);
  const { id, lessonId } = await params;
  return ok<CompleteResponse>(await completeLesson(user._id, id, lessonId));
});
