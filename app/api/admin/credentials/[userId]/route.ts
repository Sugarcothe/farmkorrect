import type { CredentialCaseResponse } from "@/lib/admin/types";
import { ADMIN_NOT_FOUND, requireAdminCapability } from "@/lib/server/admin";
import { decideCredential, getCredentialCase, parseCredentialDecision } from "@/lib/server/admin-credentials";
import { HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// One professional's credential: GET shows it with its decision history;
// POST approves or rejects the pending submission ({decision, reason,
// submittedAt}). The acting admin always comes from the session.

type Context = { params: Promise<{ userId: string }> };

export const GET = route<Context>("admin/credentials", async (request, { params }) => {
  const { user } = await requireAdminCapability(request, "admin.credentials.review");
  await limitUser("adminReadsPerUser", user._id);
  const found = await getCredentialCase((await params).userId);
  if (!found) throw new HttpError(404, ADMIN_NOT_FOUND);
  return ok<CredentialCaseResponse>(found);
});

export const POST = route<Context>("admin/credentials", async (request, { params }) => {
  const { user } = await requireAdminCapability(request, "admin.credentials.review", { mutation: true });
  await limitUser("adminActionsPerUser", user._id);
  const input = parseCredentialDecision(await readJsonBody(request));
  const { userId } = await params;
  await decideCredential(user, userId, input);
  const found = await getCredentialCase(userId);
  if (!found) throw new HttpError(404, ADMIN_NOT_FOUND);
  return ok<CredentialCaseResponse>(found);
});
