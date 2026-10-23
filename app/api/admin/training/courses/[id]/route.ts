import { requireAdminCapability } from "@/lib/server/admin";
import { HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import {
  ADMIN_COURSE_NOT_FOUND,
  findCourseForAdmin,
  MAX_COURSE_BYTES,
  toAdminCourse,
  updateCourse,
} from "@/lib/server/training-admin";
import type { AdminCourseResponse } from "@/lib/training/types";

// One course, draft or published (admins only). PUT replaces its details and
// curriculum; send the `updatedAt` you loaded (an older one is refused).

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("admin/training/course", async (request, { params }) => {
  const { user } = await requireAdminCapability(request, "admin.training.manage");
  await limitUser("adminReadsPerUser", user._id);
  const course = await findCourseForAdmin((await params).id);
  if (!course) throw new HttpError(404, ADMIN_COURSE_NOT_FOUND);
  return ok<AdminCourseResponse>({ course: toAdminCourse(course) });
});

export const PUT = route<Context>("admin/training/course", async (request, { params }) => {
  const { user } = await requireAdminCapability(request, "admin.training.manage", { mutation: true });
  await limitUser("adminActionsPerUser", user._id);
  const body = await readJsonBody(request, MAX_COURSE_BYTES);
  return ok<AdminCourseResponse>({ course: await updateCourse(user, (await params).id, body) });
});
