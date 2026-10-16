import type { MyReviewsResponse } from "@/lib/reviews/types";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { listMyReviews, REVIEWS_UNVERIFIED } from "@/lib/server/reviews";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parsePage } from "@/lib/server/wallet";

// The signed-in user's own reviews (?page=), whatever their status.

export const GET = route("reviews", async (request) => {
  const { user } = await requireVerifiedRequest(request, REVIEWS_UNVERIFIED);
  const page = parsePage(new URL(request.url).searchParams);
  await limitUser("reviewReadsPerUser", user._id);
  const { reviews, hasMore } = await listMyReviews(user._id, page);
  return ok<MyReviewsResponse>({ reviews, page, hasMore });
});
