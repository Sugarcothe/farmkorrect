import type { ProductReviewsResponse, ReviewResponse } from "@/lib/reviews/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { PRODUCT_NOT_FOUND } from "@/lib/server/products";
import { createReview, findProductReviews, parseNewReview, REVIEWS_UNVERIFIED } from "@/lib/server/reviews";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parsePage } from "@/lib/server/wallet";

// GET: a listed product's published reviews (?page=), its rating summary and
// whether the signed-in user can review it. POST: writes the signed-in
// customer's review. Only a rating and text are accepted; the reviewer,
// order, status and verified-purchase flag are decided here.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("reviews", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, REVIEWS_UNVERIFIED);
  const page = parsePage(new URL(request.url).searchParams);
  await limitUser("reviewReadsPerUser", user._id);
  const result = await findProductReviews(user._id, (await params).id, page);
  if (!result) throw new HttpError(404, PRODUCT_NOT_FOUND);
  return ok<ProductReviewsResponse>(result);
});

export const POST = route<Context>("reviews", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, REVIEWS_UNVERIFIED);
  await limitUser("reviewWritesPerUser", user._id, "Too many review changes. Please wait a while and try again.");
  const input = parseNewReview(await readJsonBody(request));
  const review = await createReview(user, (await params).id, input);
  return ok<ReviewResponse>({ review }, { status: 201 });
});
