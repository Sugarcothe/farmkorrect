import "server-only";
import { notFound, redirect } from "next/navigation";
import { getPageSession } from "./auth";
import { getAdminUserIds } from "./config";
import { assertSameOrigin, HttpError } from "./http";
import { getRequestSession, isFullyAuthenticated, type ActiveSession } from "./sessions";

// Who may use the admin area. The only source of truth is ADMIN_USER_IDS on
// the server, matched against the user id of a live, full, phone-verified
// session for an active account. Nothing the browser sends (a role, a flag,
// an id in the body, query or a cookie field) is ever consulted. Every admin
// page, read and action calls one of these itself.

/** Same answer for "not an admin" and "doesn't exist", so the area isn't advertised. */
export const ADMIN_NOT_FOUND = "We couldn't find that.";

/** Whether this session belongs to a configured admin. */
export function isAdmin(active: ActiveSession | null): active is ActiveSession {
  if (!isFullyAuthenticated(active)) return false;
  return getAdminUserIds().has(active.user._id.toHexString());
}

/**
 * For admin route handlers: the admin's session, or a 401 (no session) /
 * 404 (anyone else). Pass `mutation` for anything that changes data, which
 * also requires a same-origin request.
 */
export async function requireAdminRequest(request: Request, options: { mutation?: boolean } = {}): Promise<ActiveSession> {
  if (options.mutation) assertSameOrigin(request);
  const active = await getRequestSession(request);
  if (!active) throw new HttpError(401, "Your session has ended. Please log in again.");
  if (!isAdmin(active)) throw new HttpError(404, ADMIN_NOT_FOUND);
  return active;
}

/** For admin pages: the admin's session; sign-in for no session, a 404 page for anyone else. */
export async function requireAdminPage(): Promise<ActiveSession> {
  const active = await getPageSession();
  if (!active) redirect("/auth/sign-in");
  if (!isAdmin(active)) notFound();
  return active;
}

/** For ordinary pages deciding whether to show the admin link. */
export async function isAdminPage(): Promise<boolean> {
  return isAdmin(await getPageSession());
}
