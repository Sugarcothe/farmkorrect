import type { ProductResponse } from "@/lib/orders/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { removeProductPhoto, setMainProductPhoto } from "@/lib/server/product-images";
import { PRODUCT_NOT_FOUND, PRODUCTS_UNVERIFIED, requireSeller, toProduct } from "@/lib/server/products";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// One photo on one of the signed-in seller's listings: make it the main
// photo, or remove it. Lookups are by listing id *and* the session's account,
// so someone else's listing behaves like one that doesn't exist.

type Context = { params: Promise<{ id: string; imageId: string }> };

export const PATCH = route<Context>("product-images", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("productChangesPerUser", user._id);
  const body = await readJsonBody(request);
  const extra = Object.keys(body).filter((key) => key !== "primary");
  if (extra.length)
    throw new HttpError(
      400,
      "Some of these details can't be set on a photo.",
      Object.fromEntries(extra.map((key) => [key, "This can't be set on a photo."])),
    );
  if (body.primary !== true) throw new HttpError(400, "Choose a photo to make the main one.");
  const { id, imageId } = await params;
  const saved = await setMainProductPhoto(user._id, id, imageId);
  if (!saved) throw new HttpError(404, PRODUCT_NOT_FOUND);
  return ok<ProductResponse>({ product: toProduct(saved) });
});

export const DELETE = route<Context>("product-images", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("productChangesPerUser", user._id);
  const { id, imageId } = await params;
  const saved = await removeProductPhoto(user._id, id, imageId);
  if (!saved) throw new HttpError(404, PRODUCT_NOT_FOUND);
  return ok<ProductResponse>({ product: toProduct(saved) });
});
