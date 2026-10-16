import type { ReviewResponse } from "@/lib/reviews/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parseReviewUpdate, REVIEWS_UNVERIFIED, updateReview, withdrawReview } from "@/lib/server/reviews";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// One of the signed-in user's reviews. Every lookup is by id *and* the
// session's account, so someone else's review (or a made-up id) is a 404.
// PATCH changes the rating and/or text; DELETE withdraws the review.

type Context = { params: Promise<{ id: string }> };

const LIMITED = "Too many review changes. Please wait a while and try again.";

export const PATCH = route<Context>("reviews", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, REVIEWS_UNVERIFIED);
  await limitUser("reviewWritesPerUser", user._id, LIMITED);
  const input = parseReviewUpdate(await readJsonBody(request));
  return ok<ReviewResponse>({ review: await updateReview(user._id, (await params).id, input) });
});

export const DELETE = route<Context>("reviews", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, REVIEWS_UNVERIFIED);
  await limitUser("reviewWritesPerUser", user._id, LIMITED);
  return ok<ReviewResponse>({ review: await withdrawReview(user._id, (await params).id) });
});
