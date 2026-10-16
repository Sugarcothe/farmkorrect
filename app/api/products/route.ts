import type { ProductResponse, ProductsResponse } from "@/lib/orders/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import {
  createProduct,
  listOwnProducts,
  parseNewProduct,
  PRODUCTS_UNVERIFIED,
  requireSeller,
  toProduct,
} from "@/lib/server/products";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in seller's own product listings. The seller always comes from
// the session; there is no user id in the URL or body.

export const GET = route("products", async (request) => {
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  return ok<ProductsResponse>({ products: await listOwnProducts(user._id) });
});

export const POST = route("products", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireSeller(user.role);
  await limitUser("productChangesPerUser", user._id);
  const product = await createProduct(user._id, parseNewProduct(await readJsonBody(request)));
  return ok<ProductResponse>({ product: toProduct(product) }, { status: 201 });
});
