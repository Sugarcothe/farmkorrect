import type { ServiceResponse } from "@/lib/services/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route, tooManyRequests } from "@/lib/server/http";
import { hit } from "@/lib/server/rate-limit";
import { requireOfferingRole, SERVICES_UNVERIFIED } from "@/lib/server/service-access";
import {
  archiveOwnService,
  findOwnService,
  SERVICE_NOT_FOUND,
  toService,
  updateOwnService,
} from "@/lib/server/services";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parseServiceUpdate } from "@/lib/server/validation";
import { queueDirectoryRefresh } from "@/lib/server/vet-directory";

// One of the signed-in user's services. Every lookup is by id *and* the
// session's account, so another user's id (or a made-up one) is a 404 —
// nothing reveals whether it exists.

type Context = { params: Promise<{ id: string }> };

const notFound = () => new HttpError(404, SERVICE_NOT_FOUND);

export const GET = route<Context>("services", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, SERVICES_UNVERIFIED);
  const service = await findOwnService(user._id, (await params).id);
  if (!service) throw notFound();
  return ok<ServiceResponse>({ service: toService(service) });
});

export const PATCH = route<Context>("services", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, SERVICES_UNVERIFIED);
  requireOfferingRole(user.role);
  const limit = await hit("serviceChangesPerUser", user._id.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);

  const current = await findOwnService(user._id, (await params).id);
  if (!current) throw notFound();
  const update = parseServiceUpdate(user.role, await readJsonBody(request), current);
  // removed (or archived) between the read and the write
  const saved = await updateOwnService(user._id, current._id, update);
  if (!saved) throw notFound();
  await queueDirectoryRefresh(user);
  return ok<ServiceResponse>({ service: toService(saved) });
});

export const DELETE = route<Context>("services", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, SERVICES_UNVERIFIED);
  const limit = await hit("serviceChangesPerUser", user._id.toHexString());
  if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);

  if (!(await archiveOwnService(user._id, (await params).id))) throw notFound();
  await queueDirectoryRefresh(user);
  return ok(null);
});
