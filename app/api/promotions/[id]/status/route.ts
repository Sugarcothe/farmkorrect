import type { PromotionResponse } from "@/lib/promotions/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { PRODUCTS_UNVERIFIED, requireSeller } from "@/lib/server/products";
import { changePromotionStatus, isPromotionAction, parseExpectedVersion, toPromotions } from "@/lib/server/promotions";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// Activates, pauses or ends one of the signed-in seller's promotions.
// Orders already placed keep the price they were given.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("promotions", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("promotionChangesPerUser", user._id);
  const body = await readJsonBody(request);
  if (Object.keys(body).some((k) => k !== "action" && k !== "expectedVersion") || !isPromotionAction(body.action))
    throw new HttpError(400, "Choose to activate, pause or end the promotion.", { action: "Choose an action." });
  const saved = await changePromotionStatus(user._id, (await params).id, body.action, parseExpectedVersion(body));
  const [view] = await toPromotions([saved]);
  return ok<PromotionResponse>({ promotion: view });
});
