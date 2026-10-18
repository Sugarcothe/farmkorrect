import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { COURSE_NOT_FOUND, getCourseDetail, TRAINING_UNVERIFIED } from "@/lib/server/training";
import type { CourseDetail } from "@/lib/training/types";

// A published course with the signed-in learner's own progress. Drafts and
// unpublished courses are a 404, the same as an id that doesn't exist.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("training/course", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  await limitUser("trainingReadsPerUser", user._id);
  const course = await getCourseDetail(user._id, (await params).id);
  if (!course) throw new HttpError(404, COURSE_NOT_FOUND);
  return ok<CourseDetail>(course);
});
