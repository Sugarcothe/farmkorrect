import type { AdminCapability, AdminRole } from "./permissions";
import type { AuditEntry } from "./types";

// Operational cases: internal records of an investigation into something that
// already exists (a flagged order, booking or payout, a failed delivery, a
// reported order issue or an account). A case never changes its source and
// never stands in for it: "resolved" records what the investigation found,
// not that money moved or an account changed. Shared by browser and server.

export const CASE_TYPES = [
  "order_payment",
  "service_booking",
  "payout",
  "notification_delivery",
  "order_issue",
  "account",
] as const;

export type CaseType = (typeof CASE_TYPES)[number];

export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  order_payment: "Flagged order",
  service_booking: "Service booking",
  payout: "Payout",
  notification_delivery: "Failed delivery",
  order_issue: "Order issue",
  account: "Account",
};

/**
 * Seeing a case of a type also needs the capability that shows its source, so
 * a case never reveals a record its reader couldn't open directly.
 */
export const CASE_SOURCE_CAPABILITY: Record<CaseType, AdminCapability> = {
  order_payment: "admin.exceptions.read",
  service_booking: "admin.exceptions.read",
  payout: "admin.exceptions.read",
  notification_delivery: "admin.deliveries.read",
  order_issue: "admin.order_issues.read",
  account: "admin.users.read",
};

export const CASE_STATUSES = [
  "open",
  "in_progress",
  "waiting_customer",
  "waiting_provider",
  "resolved",
  "dismissed",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Statuses an admin can move a case between with "status"; closing has its own actions. */
export const WORKING_STATUSES = ["open", "in_progress", "waiting_customer", "waiting_provider"] as const;
export type WorkingStatus = (typeof WORKING_STATUSES)[number];
export const CLOSED_STATUSES = ["resolved", "dismissed"] as const;

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_customer: "Waiting on customer",
  waiting_provider: "Waiting on provider",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const CASE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_PRIORITY_LABELS: Record<CasePriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** Stored with each case so queues sort most urgent first. */
export const PRIORITY_RANK: Record<CasePriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** What an investigation concluded. None of these mean money moved. */
export const RESOLUTION_CODES = [
  "fixed_at_source",
  "customer_informed",
  "provider_informed",
  "escalated_finance",
  "no_issue_found",
  "duplicate",
  "other",
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

export const RESOLUTION_LABELS: Record<ResolutionCode, string> = {
  fixed_at_source: "Handled in the source record's own workflow",
  customer_informed: "Customer informed",
  provider_informed: "Provider or seller informed",
  escalated_finance: "Escalated for a finance decision",
  no_issue_found: "No problem found",
  duplicate: "Duplicate of another case",
  other: "Other (explained in the note)",
};

export const CASE_ACTIONS = ["assign", "priority", "status", "note", "resolve", "dismiss", "reopen"] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];

export const CASE_TEXT_LIMITS = {
  title: { min: 5, max: 120 },
  note: { min: 2, max: 2000 },
  resolutionNote: { min: 10, max: 1000 },
  reopenReason: { min: 5, max: 500 },
} as const;

/** A case holds at most this many notes; past that, open a follow-up case. */
export const MAX_CASE_NOTES = 200;

const includes =
  <T extends string>(list: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (list as readonly string[]).includes(value);

export const isCaseType = includes(CASE_TYPES);
export const isCaseStatus = includes(CASE_STATUSES);
export const isWorkingStatus = includes(WORKING_STATUSES);
export const isCasePriority = includes(CASE_PRIORITIES);
export const isResolutionCode = includes(RESOLUTION_CODES);
export const isCaseAction = includes(CASE_ACTIONS);

export const isClosedStatus = (status: CaseStatus) => status === "resolved" || status === "dismissed";

export type CaseNote = { id: string; authorName: string | null; body: string; at: string };

export type CaseSummary = {
  reference: string;
  type: CaseType;
  /** the order number, booking or payout reference, delivery id or user id */
  sourceId: string;
  title: string;
  priority: CasePriority;
  status: CaseStatus;
  assignee: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

/** A privacy-safe snapshot of the source, read live; null when it's gone or the viewer can't see it. */
export type CaseSourceInfo = {
  label: string;
  /** where an admin who may see it can open the source */
  href: string | null;
  facts: Array<[string, string]>;
};

export type CaseDetail = CaseSummary & {
  version: number;
  createdByName: string | null;
  notes: CaseNote[];
  resolution: { code: ResolutionCode; note: string; byName: string | null; at: string } | null;
  source: CaseSourceInfo | null;
  history: AuditEntry[];
};

export type CasePage = { cases: CaseSummary[]; page: number; hasMore: boolean };
/** Open cases over the types the viewer may see. */
export type CaseCounts = { open: number; urgent: number; unassigned: number };
export type CaseListResponse = CasePage & { counts: CaseCounts };

/** What the viewer may do with one case, worked out on the server. */
export type CasePermissions = { work: boolean; note: boolean; assign: boolean };

export type Assignee = { id: string; name: string; role: AdminRole };

export type CaseResponse = { case: CaseDetail; permissions: CasePermissions; assignees: Assignee[] };

export type CreateCaseRequest = {
  type: CaseType;
  sourceId: string;
  priority?: CasePriority;
  title?: string;
  note?: string;
};

export type CaseChangeRequest =
  | { action: "assign"; assigneeId: string | null; expectedVersion: number }
  | { action: "priority"; priority: CasePriority; expectedVersion: number }
  | { action: "status"; status: WorkingStatus; expectedVersion: number }
  | { action: "note"; note: string; expectedVersion: number }
  | { action: "resolve" | "dismiss"; code: ResolutionCode; note: string; expectedVersion: number }
  | { action: "reopen"; reason: string; expectedVersion: number };

export const CASE_REFERENCE = /^FKC-[A-Z0-9]{8}$/;
