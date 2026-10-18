import type { PromotionResponse, PromotionsResponse } from "@/lib/promotions/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { PRODUCTS_UNVERIFIED, requireSeller } from "@/lib/server/products";
import { createPromotion, listOwnPromotions, parsePromotionFields, toPromotions } from "@/lib/server/promotions";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in seller's promotions. The seller always comes from the
// session; a new promotion starts as a draft and is activated separately.

export const GET = route("promotions", async (request) => {
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("promotionReadsPerUser", user._id);
  return ok<PromotionsResponse>({ promotions: await listOwnPromotions(user._id) });
});

export const POST = route("promotions", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("promotionChangesPerUser", user._id);
  const promotion = await createPromotion(user._id, parsePromotionFields(await readJsonBody(request)));
  const [view] = await toPromotions([promotion]);
  return ok<PromotionResponse>({ promotion: view }, { status: 201 });
});
