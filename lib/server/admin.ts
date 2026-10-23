import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { ObjectId } from "mongodb";
import {
  capabilitiesOf,
  isAdminRole,
  type AdminCapability,
  type AdminRole,
  type AdminViewer,
} from "@/lib/admin/permissions";
import { getPageSession } from "./auth";
import { getAdminUserIds } from "./config";
import { getDb } from "./db";
import { assertSameOrigin, HttpError } from "./http";
import { COLLECTIONS, type AdminMembershipDoc, type UserDoc } from "./models";
import { getRequestSession, isFullyAuthenticated, type ActiveSession } from "./sessions";

// Who may do what in the admin area (docs/admin-operations-v2.md). It is
// worked out here, on every request, from two server-side sources only:
//
// - ADMIN_USER_IDS, the root allowlist. Root admins are Super Admins and
//   can't be changed or revoked in the app.
// - admin_memberships, roles a Super Admin granted in the app. They only
//   count while the root list is valid and non-empty: a missing or
//   malformed ADMIN_USER_IDS turns the whole admin area off (fail closed).
//
// Either way the session must be live, full and phone-verified, for an
// active account. Nothing the browser sends (a role, a flag, a permission
// list, an id in the body or query, a cookie field) is ever consulted.
// Every admin page, read and action calls one of the guards below itself.

/** Same answer for "not an admin" and "doesn't exist", so the area isn't advertised. */
export const ADMIN_NOT_FOUND = "We couldn't find that.";
export const ADMIN_FORBIDDEN = "Your admin role doesn't include this.";

export type AdminAccess = {
  active: ActiveSession;
  user: UserDoc;
  role: AdminRole;
  /** from ADMIN_USER_IDS */
  root: boolean;
  /** the active membership behind a granted role; null for root */
  membershipId: ObjectId | null;
  capabilities: ReadonlySet<AdminCapability>;
  can: (capability: AdminCapability) => boolean;
};

function accessOf(
  active: ActiveSession,
  role: AdminRole,
  root: boolean,
  membershipId: ObjectId | null,
): AdminAccess {
  const capabilities = capabilitiesOf(role);
  return {
    active,
    user: active.user,
    role,
    root,
    membershipId,
    capabilities,
    can: (capability) => capabilities.has(capability),
  };
}

/** Whether a user id is on the root allowlist (false whenever the list is unusable). */
export function isRootAdminId(userId: ObjectId | string): boolean {
  const id = typeof userId === "string" ? userId : userId.toHexString();
  return getAdminUserIds().has(id);
}

/**
 * The admin access a session carries, or null for anyone who isn't an
 * admin right now. Reads the membership on every call, so a revocation or
 * suspension takes effect on the very next request.
 */
export async function adminAccessFor(active: ActiveSession | null): Promise<AdminAccess | null> {
  if (!isFullyAuthenticated(active)) return null;
  const roots = getAdminUserIds();
  // fail closed: without a valid root list nobody is an admin, granted or not
  if (roots.size === 0) return null;
  const userId = active.user._id;
  if (roots.has(userId.toHexString())) return accessOf(active, "super_admin", true, null);
  const membership = await (await getDb())
    .collection<AdminMembershipDoc>(COLLECTIONS.adminMemberships)
    .findOne({ userId, status: "active" }, { projection: { role: 1 } });
  if (!membership || !isAdminRole(membership.role)) return null;
  return accessOf(active, membership.role, false, membership._id);
}

/** What the pages are told about the viewer: for showing and hiding, never for deciding. */
export const viewerOf = (access: AdminAccess): AdminViewer => ({
  role: access.role,
  root: access.root,
  capabilities: [...access.capabilities],
});

/**
 * For admin route handlers: the admin's access, or 401 (no session), 404
 * (not an admin) or 403 (an admin whose role lacks `capability`). Pass
 * `mutation` for anything that changes data, which also requires a
 * same-origin request.
 */
export async function requireAdminCapability(
  request: Request,
  capability: AdminCapability | AdminCapability[],
  options: { mutation?: boolean } = {},
): Promise<AdminAccess> {
  if (options.mutation) assertSameOrigin(request);
  const active = await getRequestSession(request);
  if (!active) throw new HttpError(401, "Your session has ended. Please log in again.");
  const access = await adminAccessFor(active);
  if (!access) throw new HttpError(404, ADMIN_NOT_FOUND);
  if (!hasAny(access, capability)) throw new HttpError(403, ADMIN_FORBIDDEN);
  return access;
}

/** For admin route handlers open to any admin (each then checks what it shows). */
export async function requireAnyAdminRequest(request: Request, options: { mutation?: boolean } = {}): Promise<AdminAccess> {
  if (options.mutation) assertSameOrigin(request);
  const active = await getRequestSession(request);
  if (!active) throw new HttpError(401, "Your session has ended. Please log in again.");
  const access = await adminAccessFor(active);
  if (!access) throw new HttpError(404, ADMIN_NOT_FOUND);
  return access;
}

const hasAny = (access: AdminAccess, capability: AdminCapability | AdminCapability[]) =>
  (Array.isArray(capability) ? capability : [capability]).some((c) => access.can(c));

/** One lookup per page render, shared by the page and its layout pieces. */
const getPageAdminAccess = cache(async (): Promise<AdminAccess | null> => adminAccessFor(await getPageSession()));

/** For admin pages open to any admin: sign-in for no session, a 404 page for anyone else. */
export async function requireAdminPage(): Promise<AdminAccess> {
  if (!(await getPageSession())) redirect("/auth/sign-in");
  const access = await getPageAdminAccess();
  if (!access) notFound();
  return access;
}

/**
 * For admin pages behind a capability. An admin without it gets the same
 * 404 page as everyone else: the page isn't there for them.
 */
export async function requireAdminCapabilityPage(
  capability: AdminCapability | AdminCapability[],
): Promise<AdminAccess> {
  const access = await requireAdminPage();
  if (!hasAny(access, capability)) notFound();
  return access;
}

/** For ordinary pages deciding whether to show the admin link. Errors hide it. */
export async function isAdminPage(): Promise<boolean> {
  try {
    return (await getPageAdminAccess()) !== null;
  } catch {
    return false;
  }
}
