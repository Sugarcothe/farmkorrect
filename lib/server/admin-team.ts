import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import type {
  ChangeRoleRequest,
  GrantRoleRequest,
  RevokedMembership,
  TeamCandidate,
  TeamMember,
  TeamMemberDetail,
  TeamOverview,
} from "@/lib/admin/accounts";
import { ADMIN_ROLE_LABELS, isAdminRole, type AdminRole } from "@/lib/admin/permissions";
import { validateAdminReason } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";
import { isRootAdminId, type AdminAccess } from "./admin";
import { findAccountDoc, parseAccountQuery, toAccountSummary } from "./admin-accounts";
import { auditFor, recordAudit } from "./admin-audit";
import { getAdminUserIds } from "./config";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type AdminMembershipDoc, type UserDoc } from "./models";
import { inTransaction } from "./order-store";

// The admin team (docs/admin-operations-v2.md): roles granted in the app on
// top of the root allowlist (ADMIN_USER_IDS). Only Super Admins get here.
//
// - A role goes to an existing account that is active and phone-verified,
//   found by an exact id, phone number or email. There are no invitations
//   and no new accounts.
// - Root admins can't be granted, changed or revoked here, so the way back
//   in can't be lost from the app.
// - Nobody changes their own role. Only a root admin grants, changes or
//   revokes the Super Admin role.
// - Every change names the version it was made against and is audited in
//   the same transaction. A revoked membership is kept; granting again
//   creates a new one.

export const MEMBER_NOT_FOUND = "We couldn't find that admin role.";
const MAX_TEAM = 200;

async function db() {
  const database = await getDb();
  return {
    users: database.collection<UserDoc>(COLLECTIONS.users),
    memberships: database.collection<AdminMembershipDoc>(COLLECTIONS.adminMemberships),
  };
}

async function namesOf(ids: ObjectId[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.map((id) => id.toHexString()))].map((id) => new ObjectId(id));
  if (!unique.length) return new Map();
  const { users } = await db();
  const docs = await users.find({ _id: { $in: unique } }, { projection: { fullName: 1 } }).toArray();
  return new Map(docs.map((u) => [u._id.toHexString(), u.fullName]));
}

const toMember = (m: AdminMembershipDoc, names: Map<string, string>): TeamMember => ({
  userId: m.userId.toHexString(),
  fullName: names.get(m.userId.toHexString()) ?? "Unknown account",
  role: m.role,
  root: false,
  membershipId: m._id.toHexString(),
  version: m.version,
  grantedByName: names.get(m.grantedBy.toHexString()) ?? null,
  grantedAt: m.grantedAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

/** Root admins (from configuration) and every active and recently revoked membership. */
export async function getTeam(): Promise<TeamOverview> {
  const { memberships } = await db();
  const rootIds = [...getAdminUserIds()].map((id) => new ObjectId(id));
  const [active, revoked] = await Promise.all([
    memberships.find({ status: "active" }).sort({ grantedAt: -1, _id: -1 }).limit(MAX_TEAM).toArray(),
    memberships.find({ status: "revoked" }).sort({ grantedAt: -1, _id: -1 }).limit(50).toArray(),
  ]);
  const names = await namesOf([
    ...rootIds,
    ...active.flatMap((m) => [m.userId, m.grantedBy]),
    ...revoked.flatMap((m) => [m.userId, ...(m.revokedBy ? [m.revokedBy] : [])]),
  ]);
  const roots: TeamMember[] = rootIds.map((id) => ({
    userId: id.toHexString(),
    fullName: names.get(id.toHexString()) ?? "Account not found",
    role: "super_admin",
    root: true,
    membershipId: null,
    version: null,
    grantedByName: null,
    grantedAt: null,
    updatedAt: null,
  }));
  return {
    members: [...roots, ...active.filter((m) => isAdminRole(m.role)).map((m) => toMember(m, names))],
    revoked: revoked.map((m): RevokedMembership => ({
      membershipId: m._id.toHexString(),
      userId: m.userId.toHexString(),
      fullName: names.get(m.userId.toHexString()) ?? "Unknown account",
      role: m.role,
      grantedAt: m.grantedAt.toISOString(),
      revokedAt: (m.revokedAt ?? m.updatedAt).toISOString(),
      revokedByName: m.revokedBy ? (names.get(m.revokedBy.toHexString()) ?? null) : null,
    })),
  };
}

/** Why a role can't be granted to this account, or null. */
function grantBlocker(access: AdminAccess, user: Pick<UserDoc, "_id" | "status" | "phoneVerifiedAt">): string | null {
  if (user._id.equals(access.user._id)) return "You can't change your own admin role.";
  if (isRootAdminId(user._id)) return "This is a root admin, managed in server configuration.";
  if (user.status !== "active") return "Only active accounts can be given an admin role.";
  if (!user.phoneVerifiedAt) return "Only accounts with a verified phone number can be given an admin role.";
  return null;
}

async function memberOf(userId: ObjectId): Promise<TeamMember | null> {
  if (isRootAdminId(userId)) {
    const names = await namesOf([userId]);
    return {
      userId: userId.toHexString(),
      fullName: names.get(userId.toHexString()) ?? "Account not found",
      role: "super_admin",
      root: true,
      membershipId: null,
      version: null,
      grantedByName: null,
      grantedAt: null,
      updatedAt: null,
    };
  }
  const { memberships } = await db();
  const m = await memberships.findOne({ userId, status: "active" });
  if (!m || !isAdminRole(m.role)) return null;
  return toMember(m, await namesOf([m.userId, m.grantedBy]));
}

/** Finds one account by exact id, phone or email, for granting a role. */
export async function findCandidate(access: AdminAccess, q: string | null): Promise<TeamCandidate | null> {
  const query = parseAccountQuery(q);
  const { users } = await db();
  const user = await users.findOne(query, {
    projection: {
      fullName: 1,
      role: 1,
      status: 1,
      phoneNormalized: 1,
      emailNormalized: 1,
      phoneVerifiedAt: 1,
      createdAt: 1,
    },
  });
  if (!user) return null;
  return { account: toAccountSummary(user), blocked: grantBlocker(access, user), current: await memberOf(user._id) };
}

export async function getTeamMember(userIdText: string): Promise<TeamMemberDetail | null> {
  if (!/^[0-9a-f]{24}$/.test(userIdText)) return null;
  const userId = new ObjectId(userIdText);
  const user = await findAccountDoc(userId);
  if (!user) return null;
  const [member, history] = await Promise.all([memberOf(userId), auditFor("membership", userIdText)]);
  return { member, account: toAccountSummary(user), history };
}

// --- changes ----------------------------------------------------------------------------

function parseReason(body: Record<string, unknown>, fieldErrors: Record<string, string>): string {
  const reason = typeof body.reason === "string" ? cleanText(body.reason, true) : "";
  const error = validateAdminReason(reason);
  if (error) fieldErrors.reason = error;
  return reason;
}

const unknownField = (body: Record<string, unknown>, allowed: string[], fieldErrors: Record<string, string>) => {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) fieldErrors[unknown[0]] = "This field can't be sent.";
};

const fail = (fieldErrors: Record<string, string>) => {
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
};

export function parseGrant(body: Record<string, unknown>): GrantRoleRequest {
  const fieldErrors: Record<string, string> = {};
  unknownField(body, ["userId", "role", "reason"], fieldErrors);
  const userId = typeof body.userId === "string" ? body.userId.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{24}$/.test(userId)) fieldErrors.userId = "Find the account first.";
  if (!isAdminRole(body.role)) fieldErrors.role = "Choose a role.";
  const reason = parseReason(body, fieldErrors);
  fail(fieldErrors);
  return { userId, role: body.role as AdminRole, reason };
}

export function parseRoleChange(body: Record<string, unknown>): ChangeRoleRequest {
  const fieldErrors: Record<string, string> = {};
  const action = body.action;
  if (action !== "change" && action !== "revoke") fieldErrors.action = "Choose change or revoke.";
  unknownField(
    body,
    action === "change" ? ["action", "role", "reason", "expectedVersion"] : ["action", "reason", "expectedVersion"],
    fieldErrors,
  );
  if (action === "change" && !isAdminRole(body.role)) fieldErrors.role = "Choose a role.";
  const reason = parseReason(body, fieldErrors);
  const expectedVersion = body.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1)
    fieldErrors.expectedVersion = "Reload and try again.";
  fail(fieldErrors);
  return action === "change"
    ? { action, role: body.role as AdminRole, reason, expectedVersion: expectedVersion as number }
    : { action: "revoke", reason, expectedVersion: expectedVersion as number };
}

const ROOT_ONLY = "Only a root admin can grant, change or revoke the Super Admin role.";

export async function grantRole(access: AdminAccess, request: GrantRoleRequest): Promise<TeamMemberDetail> {
  if (request.role === "super_admin" && !access.root) throw new HttpError(403, ROOT_ONLY);
  const userId = new ObjectId(request.userId);
  const { users, memberships } = await db();
  try {
    await inTransaction(async (session) => {
      const now = new Date();
      const user = await users.findOne({ _id: userId }, { projection: { status: 1, phoneVerifiedAt: 1 }, session });
      if (!user) throw new HttpError(404, "We couldn't find that account.");
      const blocked = grantBlocker(access, user);
      if (blocked) throw new HttpError(409, blocked);
      const doc: AdminMembershipDoc = {
        _id: new ObjectId(),
        userId,
        role: request.role,
        status: "active",
        grantedBy: access.user._id,
        grantedAt: now,
        updatedBy: access.user._id,
        updatedAt: now,
        revokedBy: null,
        revokedAt: null,
        version: 1,
      };
      // the unique index on active memberships refuses a second one
      await memberships.insertOne(doc, { session });
      await recordAudit(
        {
          actorUserId: access.user._id,
          action: "membership.grant",
          target: { type: "membership", id: request.userId },
          reason: request.reason,
          from: null,
          to: request.role,
        },
        session,
        now,
      );
    });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000)
      throw new HttpError(409, "This account already has an admin role. Change it instead.");
    throw error;
  }
  return (await getTeamMember(request.userId))!;
}

export async function changeRole(
  access: AdminAccess,
  userIdText: string,
  request: ChangeRoleRequest,
): Promise<TeamMemberDetail> {
  if (!/^[0-9a-f]{24}$/.test(userIdText)) throw new HttpError(404, MEMBER_NOT_FOUND);
  const userId = new ObjectId(userIdText);
  if (userId.equals(access.user._id)) throw new HttpError(403, "You can't change your own admin role.");
  if (isRootAdminId(userId))
    throw new HttpError(403, "Root admins are managed in server configuration and can't be changed here.");
  const { memberships } = await db();

  await inTransaction(async (session) => {
    const now = new Date();
    const current = await memberships.findOne({ userId, status: "active" }, { session });
    if (!current) throw new HttpError(404, MEMBER_NOT_FOUND);
    if (current.version !== request.expectedVersion)
      throw new HttpError(409, "This role changed since you loaded it. Reload and try again.");
    const touchesSuper =
      current.role === "super_admin" || (request.action === "change" && request.role === "super_admin");
    if (touchesSuper && !access.root) throw new HttpError(403, ROOT_ONLY);
    if (request.action === "change" && request.role === current.role)
      throw new HttpError(409, `This account is already ${ADMIN_ROLE_LABELS[current.role]}.`);

    const set =
      request.action === "change"
        ? { role: request.role, updatedBy: access.user._id, updatedAt: now }
        : {
            status: "revoked" as const,
            revokedBy: access.user._id,
            revokedAt: now,
            updatedBy: access.user._id,
            updatedAt: now,
          };
    const updated = await memberships.updateOne(
      { _id: current._id, status: "active", version: request.expectedVersion },
      { $set: set, $inc: { version: 1 } },
      { session },
    );
    if (updated.modifiedCount !== 1)
      throw new HttpError(409, "This role changed since you loaded it. Reload and try again.");
    await recordAudit(
      {
        actorUserId: access.user._id,
        action: request.action === "change" ? "membership.change" : "membership.revoke",
        target: { type: "membership", id: userIdText },
        reason: request.reason,
        from: current.role,
        to: request.action === "change" ? request.role : null,
      },
      session,
      now,
    );
  });
  return (await getTeamMember(userIdText))!;
}
