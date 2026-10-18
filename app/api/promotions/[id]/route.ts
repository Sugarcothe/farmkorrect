import type { PromotionResponse } from "@/lib/promotions/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { PRODUCTS_UNVERIFIED, requireSeller } from "@/lib/server/products";
import {
  findOwnPromotion,
  parseExpectedVersion,
  parsePromotionFields,
  PROMOTION_NOT_FOUND,
  toPromotions,
  updatePromotion,
} from "@/lib/server/promotions";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// One of the signed-in seller's promotions. Every lookup is by id *and* the
// session's account, so another seller's id (or a made-up one) is a 404.
// Edits carry the version they were made from, so a stale page can't
// overwrite a newer change.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("promotions", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("promotionReadsPerUser", user._id);
  const promotion = await findOwnPromotion(user._id, (await params).id);
  if (!promotion) throw new HttpError(404, PROMOTION_NOT_FOUND);
  const [view] = await toPromotions([promotion]);
  return ok<PromotionResponse>({ promotion: view });
});

export const PATCH = route<Context>("promotions", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("promotionChangesPerUser", user._id);
  const body = await readJsonBody(request);
  const fields = parsePromotionFields(body, ["expectedVersion"]);
  const saved = await updatePromotion(user._id, (await params).id, fields, parseExpectedVersion(body));
  const [view] = await toPromotions([saved]);
  return ok<PromotionResponse>({ promotion: view });
});
