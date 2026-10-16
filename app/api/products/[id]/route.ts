import type { ProductResponse } from "@/lib/orders/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import {
  archiveOwnProduct,
  findOwnProduct,
  parseProductUpdate,
  PRODUCT_NOT_FOUND,
  PRODUCTS_UNVERIFIED,
  requireSeller,
  toProduct,
  updateOwnProduct,
} from "@/lib/server/products";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// One of the signed-in seller's listings. Every lookup is by id *and* the
// session's account, so another seller's id (or a made-up one) is a 404.

type Context = { params: Promise<{ id: string }> };

const notFound = () => new HttpError(404, PRODUCT_NOT_FOUND);

export const GET = route<Context>("products", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  const product = await findOwnProduct(user._id, (await params).id);
  if (!product) throw notFound();
  return ok<ProductResponse>({ product: toProduct(product) });
});

export const PATCH = route<Context>("products", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("productChangesPerUser", user._id);
  const update = parseProductUpdate(await readJsonBody(request));
  const saved = await updateOwnProduct(user._id, (await params).id, update);
  if (!saved) throw notFound();
  return ok<ProductResponse>({ product: toProduct(saved) });
});

export const DELETE = route<Context>("products", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  await limitUser("productChangesPerUser", user._id);
  if (!(await archiveOwnProduct(user._id, (await params).id))) throw notFound();
  return ok(null);
});
