import type { ServiceResponse, ServicesResponse } from "@/lib/services/types";
import { assertSameOrigin, ok, readJsonBody, route, tooManyRequests } from "@/lib/server/http";
import { hit } from "@/lib/server/rate-limit";
import { requireOfferingRole, SERVICES_UNVERIFIED } from "@/lib/server/service-access";
import { createService, listServices, toService } from "@/lib/server/services";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parseNewService } from "@/lib/server/validation";
import { queueDirectoryRefresh } from "@/lib/server/vet-directory";

// The signed-in user's own services. The owner always comes from the
// session; there is no user id in the URL or body, and the role that decides
// which categories are allowed comes from the stored account.

export const GET = route("services", async (request) => {
  const { user } = await requireVerifiedRequest(request, SERVICES_UNVERIFIED);
  return ok<ServicesResponse>({ services: await listServices(user._id) });
});

export const POST = route("services", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, SERVICES_UNVERIFIED);
  requireOfferingRole(user.role);
  const limit = await hit("serviceChangesPerUser", user._id.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);

  const fields = parseNewService(user.role, await readJsonBody(request));
  const service = await createService(user._id, fields);
  await queueDirectoryRefresh(user);
  return ok<ServiceResponse>({ service: toService(service) }, { status: 201 });
});
