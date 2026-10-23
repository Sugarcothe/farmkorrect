import { requireAdminCapability } from "@/lib/server/admin";
import { ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parseStatusChange, setCourseStatus } from "@/lib/server/training-admin";
import type { AdminCourseResponse } from "@/lib/training/types";

// Publishes or unpublishes a course ({action, updatedAt}); admins only, audited.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("admin/training/status", async (request, { params }) => {
  const { user } = await requireAdminCapability(request, "admin.training.manage", { mutation: true });
  await limitUser("adminActionsPerUser", user._id);
  const change = parseStatusChange(await readJsonBody(request));
  return ok<AdminCourseResponse>({ course: await setCourseStatus(user, (await params).id, change) });
});
