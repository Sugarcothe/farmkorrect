import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parsePosition, savePosition, TRAINING_UNVERIFIED } from "@/lib/server/training";
import type { PositionResponse } from "@/lib/training/types";

// Saves the signed-in learner's playback position ({positionSeconds}) in a
// lesson of a published course. Never marks anything complete.

type Context = { params: Promise<{ id: string; lessonId: string }> };

export const PUT = route<Context>("training/position", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser(
    "trainingProgressWritesPerUser",
    user._id,
    "Progress is being saved too often. Please wait a moment.",
  );
  const seconds = parsePosition(await readJsonBody(request));
  const { id, lessonId } = await params;
  return ok<PositionResponse>(await savePosition(user._id, id, lessonId, seconds));
});
