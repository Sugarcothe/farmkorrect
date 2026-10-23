import "server-only";
import { ObjectId, type ClientSession } from "mongodb";
import type { AccountDetail, AccountPage, AccountStatus, AccountSummary } from "@/lib/admin/accounts";
import { ADMIN_PAGE_SIZE, ADMIN_TEXT_LIMITS } from "@/lib/admin/types";
import { validateAdminReason } from "@/lib/admin/validation";
import { maskPhone, normalizePhone } from "@/lib/auth/validation";
import { isAdminRole } from "@/lib/admin/permissions";
import { cleanText } from "@/lib/profile/validation";
import { isRootAdminId, type AdminAccess } from "./admin";
import { auditFor, recordAudit } from "./admin-audit";
import { getDb } from "./db";
import { HttpError } from "./http";
import {
  COLLECTIONS,
  type AdminCaseDoc,
  type AdminMembershipDoc,
  type OrderDoc,
  type PasswordResetDoc,
  type UserDoc,
} from "./models";
import { queueNotifications, syncCredentialNotification } from "./notifications";
import { inTransaction } from "./order-store";
import { revokeUserSessions } from "./sessions";

// Account lookups and suspension for the admin area
// (docs/admin-operations-v2.md). Lookups are exact (an id, a phone number or
// an email address), never a browse of the user directory, and return a
// few masked fields. Suspension is the only change made to an account from
// here: there is no deletion, no impersonation and no password access.

export const ACCOUNT_NOT_FOUND = "We couldn't find that account.";

/** The only fields ever read for an admin's view of an account. */
const ACCOUNT_PROJECTION = {
  fullName: 1,
  role: 1,
  status: 1,
  phoneNormalized: 1,
  emailNormalized: 1,
  phoneVerifiedAt: 1,
  suspension: 1,
  statusVersion: 1,
  createdAt: 1,
} as const;

type AccountFields = Pick<UserDoc, "_id" | keyof typeof ACCOUNT_PROJECTION>;

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

export function toAccountSummary(user: AccountFields): AccountSummary {
  return {
    id: user._id.toHexString(),
    fullName: user.fullName,
    role: user.role,
    status: user.status as AccountStatus,
    phoneMasked: user.phoneNormalized ? maskPhone(user.phoneNormalized) : "",
    emailMasked: user.emailNormalized ? maskEmail(user.emailNormalized) : "",
    phoneVerified: user.phoneVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

async function db() {
  const database = await getDb();
  return {
    users: database.collection<UserDoc>(COLLECTIONS.users),
    orders: database.collection<OrderDoc>(COLLECTIONS.orders),
    memberships: database.collection<AdminMembershipDoc>(COLLECTIONS.adminMemberships),
    cases: database.collection<AdminCaseDoc>(COLLECTIONS.adminCases),
    resets: database.collection<PasswordResetDoc>(COLLECTIONS.passwordResets),
  };
}

const USER_ID = /^[0-9a-f]{24}$/;

/**
 * Turns what the admin typed into one exact lookup: a user id, an email
 * address or a Nigerian phone number. Anything else is a 400, so the search
 * can't be used to list or pattern-match accounts.
 */
export function parseAccountQuery(
  raw: string | null,
): { _id: ObjectId } | { emailNormalized: string } | { phoneNormalized: string } {
  const q = (raw ?? "").trim();
  if (!q || q.length > 100)
    throw new HttpError(400, "Please correct the search.", { q: "Enter a user id, phone number or email address." });
  if (USER_ID.test(q.toLowerCase())) return { _id: new ObjectId(q.toLowerCase()) };
  if (q.includes("@")) return { emailNormalized: q.toLowerCase() };
  const phone = normalizePhone(q);
  if (phone) return { phoneNormalized: phone };
  throw new HttpError(400, "Please correct the search.", { q: "Enter a full user id, phone number or email address." });
}

/** One exact match, or none. */
export async function findAccount(query: ReturnType<typeof parseAccountQuery>): Promise<AccountSummary | null> {
  const { users } = await db();
  const user = await users.findOne(query, { projection: ACCOUNT_PROJECTION });
  return user ? toAccountSummary(user) : null;
}

export async function findAccountDoc(userId: ObjectId): Promise<AccountFields | null> {
  const { users } = await db();
  return users.findOne({ _id: userId }, { projection: ACCOUNT_PROJECTION });
}

/** Suspended accounts, most recently suspended first. */
export async function listSuspendedAccounts(page: number, pageSize = ADMIN_PAGE_SIZE): Promise<AccountPage> {
  const { users } = await db();
  const docs = await users
    .find({ status: "suspended" }, { projection: ACCOUNT_PROJECTION })
    .sort({ "suspension.at": -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  return { accounts: docs.slice(0, pageSize).map(toAccountSummary), page, hasMore: docs.length > pageSize };
}

export async function countSuspendedAccounts(): Promise<number> {
  const { users } = await db();
  return users.countDocuments({ status: "suspended" });
}

/** The account's current admin role, if any. */
export async function adminRoleOf(userId: ObjectId): Promise<AccountDetail["admin"]> {
  if (isRootAdminId(userId)) return { role: "super_admin", root: true };
  const { memberships } = await db();
  const membership = await memberships.findOne({ userId, status: "active" }, { projection: { role: 1 } });
  return membership && isAdminRole(membership.role) ? { role: membership.role, root: false } : null;
}

export async function getAccountDetail(userIdText: string): Promise<AccountDetail | null> {
  if (!USER_ID.test(userIdText)) return null;
  const userId = new ObjectId(userIdText);
  const user = await findAccountDoc(userId);
  if (!user) return null;
  const { users, orders, cases } = await db();
  const [ordersAsBuyer, ordersAsSeller, openCases, admin, history, by] = await Promise.all([
    // both served by the existing buyer and seller order indexes
    orders.countDocuments({ buyerUserId: userId }),
    orders.countDocuments({ sellerUserId: userId }),
    cases.countDocuments({ sourceKey: `account:${userIdText}` }),
    adminRoleOf(userId),
    auditFor("user", userIdText),
    user.suspension
      ? users.findOne({ _id: user.suspension.by }, { projection: { fullName: 1 } })
      : Promise.resolve(null),
  ]);
  return {
    ...toAccountSummary(user),
    statusVersion: user.statusVersion ?? 0,
    suspension: user.suspension
      ? { state: user.suspension.state, at: user.suspension.at.toISOString(), byName: by?.fullName ?? null }
      : null,
    admin,
    activity: { ordersAsBuyer, ordersAsSeller, openCases },
    history,
  };
}

// --- suspend and reactivate ----------------------------------------------------------

export type StatusChange = { action: "suspend" | "reactivate"; reason: string; expectedVersion: number };

export function parseStatusChange(body: Record<string, unknown>): StatusChange {
  const fieldErrors: Record<string, string> = {};
  const unknown = Object.keys(body).filter((k) => !["action", "reason", "expectedVersion", "confirmed"].includes(k));
  if (unknown.length) fieldErrors[unknown[0]] = "This field can't be sent.";
  const action = body.action;
  if (action !== "suspend" && action !== "reactivate") fieldErrors.action = "Choose suspend or reactivate.";
  const reason = typeof body.reason === "string" ? cleanText(body.reason, true) : "";
  const reasonError = validateAdminReason(reason);
  if (reasonError) fieldErrors.reason = reasonError;
  else if (reason.length > ADMIN_TEXT_LIMITS.reason.max) fieldErrors.reason = "That reason is too long.";
  const expectedVersion = body.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 0)
    fieldErrors.expectedVersion = "Reload the account and try again.";
  if (body.confirmed !== true) fieldErrors.confirmed = "Confirm you understand what this does.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
  return { action: action as StatusChange["action"], reason, expectedVersion: expectedVersion as number };
}

// accounts created before statusVersion existed have none: they count as version 0
const versionFilter = (expected: number) => (expected === 0 ? { $not: { $gt: 0 } } : expected);

/**
 * Suspends or reactivates an account. In one transaction: the status change
 * (only from the status and version the admin saw), the session revocation
 * and, when suspending, the end of any admin role and of outstanding reset
 * links, plus the audit records. The owner is notified afterwards through
 * the outbox, without the admin's reason. Nothing else changes: orders,
 * bookings, payouts, ledger entries, credentials and reviews stay as they
 * are, and reactivating restores none of what suspension revoked.
 */
export async function changeAccountStatus(
  access: AdminAccess,
  userIdText: string,
  change: StatusChange,
): Promise<AccountDetail> {
  if (!USER_ID.test(userIdText)) throw new HttpError(404, ACCOUNT_NOT_FOUND);
  const userId = new ObjectId(userIdText);
  if (userId.equals(access.user._id)) throw new HttpError(403, "You can't change your own account's status.");
  // root admins are the way back in; they're managed in server configuration only
  if (isRootAdminId(userId))
    throw new HttpError(403, "Root admins can't be suspended here. They are managed in server configuration.");

  const { users, memberships, resets } = await db();
  const suspend = change.action === "suspend";
  const from: AccountStatus = suspend ? "active" : "suspended";
  const to: AccountStatus = suspend ? "suspended" : "active";

  await inTransaction(async (session: ClientSession) => {
    const now = new Date();
    const current = await users.findOne({ _id: userId }, { projection: { status: 1, statusVersion: 1 }, session });
    if (!current) throw new HttpError(404, ACCOUNT_NOT_FOUND);
    if ((current.statusVersion ?? 0) !== change.expectedVersion || current.status !== from)
      throw new HttpError(
        409,
        current.status === to
          ? `This account is already ${to === "active" ? "active" : "suspended"}.`
          : "This account changed since you loaded it. Reload and try again.",
      );
    if (suspend && !access.root) {
      const held = await memberships.findOne({ userId, status: "active" }, { projection: { role: 1 }, session });
      if (held?.role === "super_admin") throw new HttpError(403, "Only a root admin can suspend another Super Admin.");
    }
    const updated = await users.updateOne(
      { _id: userId, status: from, statusVersion: versionFilter(change.expectedVersion) },
      {
        $set: {
          status: to,
          suspension: { state: suspend ? "suspended" : "reactivated", by: access.user._id, at: now },
          statusVersion: change.expectedVersion + 1,
          notifySyncAt: now,
          updatedAt: now,
        },
      },
      { session },
    );
    if (updated.modifiedCount !== 1)
      throw new HttpError(409, "This account changed since you loaded it. Reload and try again.");
    await recordAudit(
      {
        actorUserId: access.user._id,
        action: suspend ? "user.suspend" : "user.reactivate",
        target: { type: "user", id: userIdText },
        reason: change.reason,
        from,
        to,
      },
      session,
      now,
    );
    if (!suspend) return;
    await revokeUserSessions(userId, session);
    await resets.updateMany({ userId, usedAt: null, supersededAt: null }, { $set: { supersededAt: now } }, { session });
    const membership = await memberships.findOneAndUpdate(
      { userId, status: "active" },
      {
        $set: {
          status: "revoked",
          revokedBy: access.user._id,
          revokedAt: now,
          updatedBy: access.user._id,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: "before" },
    );
    if (membership)
      await recordAudit(
        {
          actorUserId: access.user._id,
          action: "membership.revoke",
          target: { type: "membership", id: userIdText },
          reason: "Account suspended.",
          from: membership.role,
          to: null,
        },
        session,
        now,
      );
  });

  await queueNotifications("account status notice", () => syncCredentialNotification(userId));
  const detail = await getAccountDetail(userIdText);
  if (!detail) throw new HttpError(404, ACCOUNT_NOT_FOUND);
  return detail;
}
