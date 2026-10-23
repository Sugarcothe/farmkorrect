// Shapes the admin & support API sends and accepts, shared by the browser and
// the server. Who is an admin is decided on the server only (ADMIN_USER_IDS);
// nothing here grants access. Every list is a page of small summaries built
// on the server, never whole database records.

export const ADMIN_ACTIONS = [
  "credential.approve",
  "credential.reject",
  "order_issue.close",
  "review.publish",
  "review.reject",
  "review.remove",
  "review.restore",
  "course.create",
  "course.update",
  "course.publish",
  "course.unpublish",
  "membership.grant",
  "membership.change",
  "membership.revoke",
  "user.suspend",
  "user.reactivate",
  "case.create",
  "case.assign",
  "case.priority",
  "case.status",
  "case.note",
  "case.resolve",
  "case.dismiss",
  "case.reopen",
] as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export const ADMIN_ACTION_LABELS: Record<AdminAction, string> = {
  "credential.approve": "Credential approved",
  "credential.reject": "Credential rejected",
  "order_issue.close": "Order issue closed",
  "review.publish": "Review published",
  "review.reject": "Review rejected",
  "review.remove": "Review removed",
  "review.restore": "Review restored",
  "course.create": "Course created",
  "course.update": "Course edited",
  "course.publish": "Course published",
  "course.unpublish": "Course unpublished",
  "membership.grant": "Admin role granted",
  "membership.change": "Admin role changed",
  "membership.revoke": "Admin role revoked",
  "user.suspend": "Account suspended",
  "user.reactivate": "Account reactivated",
  "case.create": "Case opened",
  "case.assign": "Case assigned",
  "case.priority": "Case priority changed",
  "case.status": "Case status changed",
  "case.note": "Case note added",
  "case.resolve": "Case resolved",
  "case.dismiss": "Case dismissed",
  "case.reopen": "Case reopened",
};

export const isAdminAction = (value: unknown): value is AdminAction =>
  typeof value === "string" && (ADMIN_ACTIONS as readonly string[]).includes(value);

export const AUDIT_TARGET_TYPES = ["user", "order", "review", "course", "membership", "case"] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export const isAuditTargetType = (value: unknown): value is AuditTargetType =>
  typeof value === "string" && (AUDIT_TARGET_TYPES as readonly string[]).includes(value);

/** Reasons and notes typed by an admin: required where asked for, trimmed, bounded. */
export const ADMIN_TEXT_LIMITS = {
  reason: { min: 5, max: 500 },
  resolutionNote: { min: 10, max: 1000 },
} as const;

export const ADMIN_PAGE_SIZE = 20;

/** One line of the audit trail, as the admin area shows it. */
export type AuditEntry = {
  id: string;
  action: AdminAction;
  /** null: done by the internal job endpoint, not a person */
  actorUserId: string | null;
  actorName: string | null;
  target: { type: AuditTargetType; id: string };
  /** the reason or internal note given, if any (admins only) */
  reason: string | null;
  from: string | null;
  to: string | null;
  at: string;
};

export type AuditPage = { entries: AuditEntry[]; page: number; hasMore: boolean };

/**
 * Dashboard counts. A key is left out when the viewer's role doesn't cover
 * that queue, and is null when counting it failed: the page then shows an
 * error, never a zero it doesn't know to be true.
 */
export type AdminSummary = {
  pendingCredentials?: number | null;
  openIssues?: number | null;
  reviewsToModerate?: number | null;
  flaggedOrders?: number | null;
  flaggedPayouts?: number | null;
  flaggedBookings?: number | null;
  failedDeliveries?: number | null;
  openCases?: number | null;
  urgentCases?: number | null;
  unassignedCases?: number | null;
  suspendedAccounts?: number | null;
  /** suspensions and reactivations in the last 7 days */
  recentAccountActions?: number | null;
  /** left out without audit access; null when it couldn't be read */
  recentActions?: AuditEntry[] | null;
};

export type CredentialCase = {
  userId: string;
  fullName: string;
  role: "veterinarian" | "non-vet-specialist";
  registrationNumber: string;
  specialization: string;
  qualifications: string;
  location: string;
  status: "not_submitted" | "pending" | "verified" | "rejected";
  submittedAt: string | null;
  reviewedAt: string | null;
};

export type CredentialPage = { cases: CredentialCase[]; page: number; hasMore: boolean };

export type CredentialDecision = "approve" | "reject";

export type CredentialDecisionRequest = {
  decision: CredentialDecision;
  /** required when rejecting */
  reason?: string;
  /** the submission the admin looked at; a newer one is refused as stale */
  submittedAt: string;
};

export type IssueCase = {
  orderNumber: string;
  buyerName: string;
  sellerName: string;
  reportedAt: string;
  note: string;
  open: boolean;
  closedAt: string | null;
  /** the internal resolution note (admins only) */
  resolutionNote: string | null;
  /** what the buyer was charged, after any seller promotion */
  totalKobo: number;
  /** the seller-funded discount on the order (0 when none) */
  discountKobo: number;
  /** "Name" or "Code CODE" of that promotion, as placed */
  promotionLabel: string | null;
  paymentStatus: string;
  fulfillmentStatus: string;
  refundedKobo: number;
  refundPendingKobo: number;
  /** the seller's earning for this order is on hold in the ledger */
  earningHeld: boolean;
};

export type IssuePage = { cases: IssueCase[]; page: number; hasMore: boolean };

export type CloseIssueRequest = {
  note: string;
  /** the admin confirmed the case is resolved and any refund was already handled */
  confirmed: true;
};

export const MODERATION_ACTIONS = ["publish", "reject", "remove", "restore"] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const isModerationAction = (value: unknown): value is ModerationAction =>
  typeof value === "string" && (MODERATION_ACTIONS as readonly string[]).includes(value);

export type ModerationStatus = "pending" | "published" | "rejected";

/**
 * The only moves moderation can make. Withdrawn reviews belong to their
 * author and are never moderated.
 */
export const MODERATION_TRANSITIONS: Record<ModerationAction, { from: ModerationStatus; to: ModerationStatus; reason: boolean }> = {
  publish: { from: "pending", to: "published", reason: false },
  reject: { from: "pending", to: "rejected", reason: true },
  remove: { from: "published", to: "rejected", reason: true },
  restore: { from: "rejected", to: "published", reason: true },
};

export type ModerationCase = {
  id: string;
  productId: string;
  productName: string;
  reviewerName: string;
  rating: number;
  text: string;
  status: ModerationStatus | "withdrawn";
  verifiedPurchase: boolean;
  createdAt: string;
  /** the version the admin is looking at; an edit since then makes an action stale */
  updatedAt: string;
  /** the viewing admin sold the product or wrote the review, so can't moderate it */
  conflict: boolean;
};

export type ModerationPage = { cases: ModerationCase[]; page: number; hasMore: boolean };

export type ModerationRequest = { action: ModerationAction; reason?: string; updatedAt: string };

export const EXCEPTION_KINDS = ["orders", "bookings", "payouts", "deliveries"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const isExceptionKind = (value: unknown): value is ExceptionKind =>
  typeof value === "string" && (EXCEPTION_KINDS as readonly string[]).includes(value);

/** A short, fixed description of why something was flagged, derived on the server. */
export const EXCEPTION_CATEGORIES = [
  "amount_mismatch",
  "totals_mismatch",
  "refund_failed",
  "refund_mismatch",
  "ledger_refused",
  "provider_mismatch",
  "late_provider_event",
  "unexpected_provider_status",
  "other",
] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];

export const EXCEPTION_CATEGORY_LABELS: Record<ExceptionCategory, string> = {
  amount_mismatch: "Paid amount doesn't match",
  totals_mismatch: "Totals don't add up",
  refund_failed: "Refund failed",
  refund_mismatch: "Refund amount doesn't match",
  ledger_refused: "Ledger refused the entry",
  provider_mismatch: "Provider details don't match",
  late_provider_event: "Late or conflicting provider event",
  unexpected_provider_status: "Unexpected provider status",
  other: "Other",
};

/**
 * What is known about the money for a flagged item. "ambiguous" means the
 * provider's outcome isn't known, so nobody should assume it failed or worked.
 */
export type MoneyOutcome = "confirmed" | "failed" | "ambiguous" | "in_progress";

export const MONEY_OUTCOME_LABELS: Record<MoneyOutcome, string> = {
  confirmed: "Confirmed",
  failed: "Failed",
  ambiguous: "Outcome unknown",
  in_progress: "In progress",
};

/** The open case for a flagged item, if one exists. */
export type ExceptionCaseLink = { reference: string; status: string } | null;

export type FlaggedOrder = {
  orderNumber: string;
  issue: string;
  category: ExceptionCategory;
  paymentStatus: string;
  outcome: MoneyOutcome;
  fulfillmentStatus: string;
  /** what the order should have been paid */
  totalKobo: number;
  /** what the provider reported as paid; null when nothing was recorded */
  paidKobo: number | null;
  updatedAt: string;
  openCase: ExceptionCaseLink;
};

/** A flagged Other Services booking. Read only: no refund or payment action exists here. */
export type FlaggedBooking = {
  reference: string;
  status: string;
  paymentStatus: string;
  outcome: MoneyOutcome;
  category: ExceptionCategory;
  /** the sanitized reason, never a provider payload */
  issue: string;
  expectedKobo: number;
  paidKobo: number | null;
  refundedKobo: number;
  /** the latest refund attempt's status, if any */
  refundStatus: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  openCase: ExceptionCaseLink;
};

/** A payout that needs a look. Bank details are reduced to the last four digits. */
export type FlaggedPayout = {
  reference: string;
  issue: string;
  category: ExceptionCategory;
  status: string;
  outcome: MoneyOutcome;
  /** what the payout was for */
  amountKobo: number;
  bankName: string;
  accountNumberLast4: string;
  failureReason: string | null;
  updatedAt: string;
  openCase: ExceptionCaseLink;
};

export type FailedDelivery = {
  id: string;
  channel: string;
  state: "failed" | "exhausted";
  attempts: number;
  /** a short failure category, never message content or contact details */
  lastFailure: string | null;
  notificationType: string | null;
  updatedAt: string;
  openCase: ExceptionCaseLink;
};

export type ExceptionPage =
  | { kind: "orders"; items: FlaggedOrder[]; page: number; hasMore: boolean }
  | { kind: "bookings"; items: FlaggedBooking[]; page: number; hasMore: boolean }
  | { kind: "payouts"; items: FlaggedPayout[]; page: number; hasMore: boolean }
  | { kind: "deliveries"; items: FailedDelivery[]; page: number; hasMore: boolean };

export type CredentialCaseResponse = { case: CredentialCase; history: AuditEntry[] };
export type IssueCaseResponse = { case: IssueCase; history: AuditEntry[] };
export type ModerationResponse = { review: ModerationCase };
