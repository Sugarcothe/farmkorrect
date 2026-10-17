import type { ModerationPage } from "@/lib/admin/types";
import { requireAdminRequest } from "@/lib/server/admin";
import { isModerationStatus, listReviewsForModeration } from "@/lib/server/admin-reviews";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// Reviews by status for moderation: ?status=pending (default), published or rejected.

export const GET = route("admin/reviews", async (request) => {
  const { user } = await requireAdminRequest(request);
  const params = new URL(request.url).searchParams;
  const status = params.get("status") ?? "pending";
  if (!isModerationStatus(status))
    throw new HttpError(400, "Please correct the filters.", { status: "Choose pending, published or rejected." });
  const page = parsePage(params);
  await limitUser("adminReadsPerUser", user._id);
  return ok<ModerationPage>(await listReviewsForModeration(user._id, status, page));
});
