import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { getLessonView, LESSON_NOT_FOUND, TRAINING_UNVERIFIED } from "@/lib/server/training";
import type { LessonView } from "@/lib/training/types";

// One lesson of a published course: its video and PDF resources (validated
// delivery URLs only), the learner's saved position and the curriculum.

type Context = { params: Promise<{ id: string; lessonId: string }> };

export const GET = route<Context>("training/lesson", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("trainingReadsPerUser", user._id);
  const { id, lessonId } = await params;
  const lesson = await getLessonView(user._id, id, lessonId);
  if (!lesson) throw new HttpError(404, LESSON_NOT_FOUND);
  return ok<LessonView>(lesson);
});
