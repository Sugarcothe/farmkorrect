import type { Role } from "@/lib/auth/types";
import type { AdminRole } from "./permissions";
import type { AuditEntry } from "./types";

// Shapes for the admin team (/admin/team) and account lookups
// (/admin/users), shared by browser and server. Contact details only ever
// leave the server masked; nothing here carries passwords, tokens, OTPs,
// bank details or provider data.

export type AccountStatus = "pending_verification" | "active" | "suspended";

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  pending_verification: "Not verified",
  active: "Active",
  suspended: "Suspended",
};

/** An account as an admin sees it: enough to recognise it, nothing more. */
export type AccountSummary = {
  id: string;
  fullName: string;
  role: Role;
  status: AccountStatus;
  /** e.g. +234******6789 */
  phoneMasked: string;
  /** e.g. a•••@example.com */
  emailMasked: string;
  phoneVerified: boolean;
  createdAt: string;
};

export type AccountDetail = AccountSummary & {
  /** bumped by each suspend or reactivate; actions name the version they were made against */
  statusVersion: number;
  suspension: { state: "suspended" | "reactivated"; at: string; byName: string | null } | null;
  /** the account's admin role, if any (root admins come from server configuration) */
  admin: { role: AdminRole; root: boolean } | null;
  activity: { ordersAsBuyer: number; ordersAsSeller: number; openCases: number };
  history: AuditEntry[];
};

export type AccountPage = { accounts: AccountSummary[]; page: number; hasMore: boolean };

export type AccountStatusRequest = {
  action: "suspend" | "reactivate";
  reason: string;
  /** the account's statusVersion the admin was looking at */
  expectedVersion: number;
  /** the admin confirmed the consequences */
  confirmed: true;
};

export type TeamMember = {
  userId: string;
  fullName: string;
  role: AdminRole;
  root: boolean;
  /** null for root admins */
  membershipId: string | null;
  version: number | null;
  grantedByName: string | null;
  grantedAt: string | null;
  updatedAt: string | null;
};

export type RevokedMembership = {
  membershipId: string;
  userId: string;
  fullName: string;
  role: AdminRole;
  grantedAt: string;
  revokedAt: string;
  revokedByName: string | null;
};

export type TeamOverview = { members: TeamMember[]; revoked: RevokedMembership[] };

/** One account found for granting a role: shown so the Super Admin can confirm it's the right person. */
export type TeamCandidate = {
  account: AccountSummary;
  /** why a role can't be granted to it, if it can't */
  blocked: string | null;
  current: TeamMember | null;
};

export type TeamMemberDetail = {
  member: TeamMember | null;
  account: AccountSummary;
  history: AuditEntry[];
};

export type GrantRoleRequest = { userId: string; role: AdminRole; reason: string };
export type ChangeRoleRequest =
  | { action: "change"; role: AdminRole; reason: string; expectedVersion: number }
  | { action: "revoke"; reason: string; expectedVersion: number };

export type AccountLookupResponse = { account: AccountSummary | null };
export type TeamLookupResponse = { candidate: TeamCandidate | null };
