// The admin capability matrix (docs/admin-operations-v2.md), shared by the
// browser and the server. It only describes what each role may do: whether
// someone holds a role is decided on the server from ADMIN_USER_IDS and the
// admin_memberships collection, never from anything the browser sends.

export const ADMIN_CAPABILITIES = [
  "admin.team.manage",
  "admin.users.read",
  "admin.users.suspend",
  "admin.cases.read",
  "admin.cases.manage",
  "admin.cases.assign",
  "admin.credentials.review",
  "admin.reviews.moderate",
  "admin.order_issues.read",
  "admin.order_issues.resolve",
  "admin.exceptions.read",
  "admin.deliveries.read",
  "admin.analytics.read",
  "admin.training.manage",
  "admin.audit.read",
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export const ADMIN_CAPABILITY_LABELS: Record<AdminCapability, string> = {
  "admin.team.manage": "Grant, change and revoke admin roles",
  "admin.users.read": "Look up accounts",
  "admin.users.suspend": "Suspend and reactivate accounts",
  "admin.cases.read": "See operational cases",
  "admin.cases.manage": "Open cases, add notes and work cases that are theirs or unassigned",
  "admin.cases.assign": "Assign any case to anyone and work any case",
  "admin.credentials.review": "Approve or reject vet and specialist credentials",
  "admin.reviews.moderate": "Moderate product reviews",
  "admin.order_issues.read": "See problems buyers reported on orders",
  "admin.order_issues.resolve": "Close order issues (releases the seller's held earning)",
  "admin.exceptions.read": "Investigate flagged orders, service bookings and payouts",
  "admin.deliveries.read": "Investigate failed email, SMS and push deliveries",
  "admin.analytics.read": "Marketplace and financial reports",
  "admin.training.manage": "Create, edit and publish training courses",
  "admin.audit.read": "Read the whole admin audit trail",
};

export const ADMIN_ROLES = ["super_admin", "support_agent", "trust_safety", "finance_ops", "content_manager"] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: "Super Admin",
  support_agent: "Support Agent",
  trust_safety: "Trust & Safety",
  finance_ops: "Finance Operations",
  content_manager: "Content Manager",
};

export const ADMIN_ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  super_admin: "Everything, including the admin team. Only a root admin can make someone a Super Admin.",
  support_agent:
    "Account lookups, order issues, failed deliveries and working cases. No money, credentials or reviews.",
  trust_safety: "Credential review, review moderation, account lookups and cases about them.",
  finance_ops: "Flagged orders, bookings and payouts, closing order issues, reports and cases about them.",
  content_manager: "Training courses only.",
};

/**
 * Least privilege: each role gets only what its job needs. Nothing here moves
 * money: closing an order issue releases a held earning through the existing
 * ledger rules, and no capability refunds, pays out or edits the ledger.
 */
export const ROLE_CAPABILITIES: Record<AdminRole, readonly AdminCapability[]> = {
  super_admin: ADMIN_CAPABILITIES,
  support_agent: [
    "admin.users.read",
    "admin.cases.read",
    "admin.cases.manage",
    "admin.order_issues.read",
    "admin.deliveries.read",
  ],
  trust_safety: [
    "admin.users.read",
    "admin.cases.read",
    "admin.cases.manage",
    "admin.credentials.review",
    "admin.reviews.moderate",
  ],
  finance_ops: [
    "admin.cases.read",
    "admin.cases.manage",
    "admin.order_issues.read",
    "admin.order_issues.resolve",
    "admin.exceptions.read",
    "admin.analytics.read",
  ],
  content_manager: ["admin.training.manage"],
};

export const isAdminRole = (value: unknown): value is AdminRole =>
  typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);

export const isAdminCapability = (value: unknown): value is AdminCapability =>
  typeof value === "string" && (ADMIN_CAPABILITIES as readonly string[]).includes(value);

export const capabilitiesOf = (role: AdminRole): ReadonlySet<AdminCapability> => new Set(ROLE_CAPABILITIES[role]);

/** What the server tells the admin pages about the viewer (never used to authorize). */
export type AdminViewer = {
  role: AdminRole;
  /** from ADMIN_USER_IDS: can't be changed or revoked in the app */
  root: boolean;
  capabilities: AdminCapability[];
};
