import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import {
  getMarketplaceService,
  MARKETPLACE_SERVICE_NOT_FOUND,
  SERVICE_DIRECTORY_UNVERIFIED,
} from "@/lib/server/service-directory";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import type { MarketplaceServiceDetails } from "@/lib/services/marketplace";

// A listed marketplace service's public details. Unlisted, removed and
// unknown services all get the same 404.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("service-directory", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, SERVICE_DIRECTORY_UNVERIFIED);
  await limitUser("serviceSearchesPerUser", user._id, "Too many requests. Please wait a moment and try again.");
  const service = await getMarketplaceService((await params).id, user._id);
  if (!service) throw new HttpError(404, MARKETPLACE_SERVICE_NOT_FOUND);
  return ok<{ service: MarketplaceServiceDetails }>({ service });
});
