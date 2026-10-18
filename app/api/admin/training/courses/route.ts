import { requireAdminRequest } from "@/lib/server/admin";
import { ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { createCourse, listCoursesForAdmin, MAX_COURSE_BYTES } from "@/lib/server/training-admin";
import { parsePage } from "@/lib/server/wallet";
import type { AdminCoursePage, AdminCourseResponse } from "@/lib/training/types";

// Korret Academy content, for configured admins only. GET: every course,
// drafts included, most recently edited first (?page). POST: a new draft.

export const GET = route("admin/training", async (request) => {
  const { user } = await requireAdminRequest(request);
  const page = parsePage(new URL(request.url).searchParams);
  await limitUser("adminReadsPerUser", user._id);
  return ok<AdminCoursePage>(await listCoursesForAdmin(page));
});

export const POST = route("admin/training", async (request) => {
  const { user } = await requireAdminRequest(request, { mutation: true });
  await limitUser("adminActionsPerUser", user._id);
  const course = await createCourse(user, await readJsonBody(request, MAX_COURSE_BYTES));
  return ok<AdminCourseResponse>({ course }, { status: 201 });
});
