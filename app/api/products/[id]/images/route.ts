import { PRODUCT_PHOTO_RULES, type ProductResponse } from "@/lib/orders/types";
import { isImageStorageConfigured, PHOTO_UNAVAILABLE } from "@/lib/server/cloudinary";
import { declaredPhotoType, processProductPhoto } from "@/lib/server/images";
import { assertSameOrigin, HttpError, ok, readLimitedBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { addProductPhoto, findListingWithRoom } from "@/lib/server/product-images";
import { PRODUCT_NOT_FOUND, PRODUCTS_UNVERIFIED, requireSeller, toProduct } from "@/lib/server/products";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// Adds a photo to one of the signed-in seller's listings. The body is the raw
// image bytes (not a form), capped in size, checked by its actual content and
// re-encoded on this server; only the cleaned WebP goes on to Cloudinary.

type Context = { params: Promise<{ id: string }> };

const MAX_MB = PRODUCT_PHOTO_RULES.maxBytes / (1024 * 1024);

export const POST = route<Context>("product-images", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  if (!isImageStorageConfigured()) throw new HttpError(503, PHOTO_UNAVAILABLE);

  const declared = declaredPhotoType(request.headers.get("content-type"));
  if (!declared) throw new HttpError(415, "Choose a JPG, PNG or WebP photo.");

  await limitUser(
    "productPhotoUploadsPerUser",
    user._id,
    "You've added a lot of photos recently. Please try again later.",
  );
  const { id } = await params;
  if (!(await findListingWithRoom(user._id, id))) throw new HttpError(404, PRODUCT_NOT_FOUND);

  const bytes = await readLimitedBody(request, PRODUCT_PHOTO_RULES.maxBytes, `That photo is too large. Choose one under ${MAX_MB} MB.`);
  const photo = await processProductPhoto(bytes, declared);
  const saved = await addProductPhoto(user._id, id, photo);
  if (!saved) throw new HttpError(404, PRODUCT_NOT_FOUND);
  return ok<ProductResponse>({ product: toProduct(saved) }, { status: 201 });
});
