import type { ModerationResponse } from "@/lib/admin/types";
import { requireAdminRequest } from "@/lib/server/admin";
import { moderateReview, parseModeration } from "@/lib/server/admin-reviews";
import { ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// Moderates one review ({action, reason, updatedAt}): publish, reject,
// remove or restore. Never changes the rating or text, never deletes.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("admin/reviews", async (request, { params }) => {
  const { user } = await requireAdminRequest(request, { mutation: true });
  await limitUser("adminActionsPerUser", user._id);
  const input = parseModeration(await readJsonBody(request));
  return ok<ModerationResponse>({ review: await moderateReview(user, (await params).id, input) });
});
