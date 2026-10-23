import "server-only";
import { randomInt } from "node:crypto";
import { MongoServerError, ObjectId, type Filter, type Sort, type UpdateFilter } from "mongodb";
import { ACCOUNT_STATUS_LABELS, type AccountStatus } from "@/lib/admin/accounts";
import {
  CASE_PRIORITY_LABELS,
  CASE_SOURCE_CAPABILITY,
  CASE_STATUS_LABELS,
  CASE_TEXT_LIMITS,
  CASE_TYPES,
  isCasePriority,
  isCaseStatus,
  isCaseType,
  isClosedStatus,
  isResolutionCode,
  isWorkingStatus,
  MAX_CASE_NOTES,
  PRIORITY_RANK,
  type Assignee,
  type CaseChangeRequest,
  type CaseCounts,
  type CaseDetail,
  type CasePage,
  type CasePermissions,
  type CasePriority,
  type CaseResponse,
  type CaseSourceInfo,
  type CaseStatus,
  type CaseSummary,
  type CaseType,
  type CreateCaseRequest,
} from "@/lib/admin/cases";
import { ADMIN_ROLES, ROLE_CAPABILITIES, type AdminCapability, type AdminRole } from "@/lib/admin/permissions";
import { ADMIN_PAGE_SIZE, EXCEPTION_CATEGORY_LABELS, type ExceptionCaseLink } from "@/lib/admin/types";
import { validateLimitedText } from "@/lib/admin/validation";
import { ROLE_LABELS } from "@/lib/auth/types";
import { cleanText } from "@/lib/profile/validation";
import { formatKobo } from "@/lib/wallet/money";
import { type AdminAccess } from "./admin";
import { auditFor, recordAudit } from "./admin-audit";
import { issueCategory, sanitizeIssue } from "./admin-flags";
import { getAdminUserIds } from "./config";
import { getDb } from "./db";
import { HttpError } from "./http";
import {
  COLLECTIONS,
  type AdminCaseDoc,
  type AdminMembershipDoc,
  type NotificationDeliveryDoc,
  type OrderDoc,
  type PayoutDoc,
  type ServiceBookingDoc,
  type UserDoc,
} from "./models";
import { inTransaction } from "./order-store";

// The case centre (docs/admin-operations-v2.md). A case is an internal
// record of an investigation into something that already exists. Opening,
// working or closing one never changes its source: no order, booking,
// payout, refund, ledger entry, delivery or account is touched from here.
//
// - One open case per source: `sourceKey` exists only while a case is open
//   and has a unique partial index.
// - Every change names the version it was made against (409 when stale)
//   and is audited in the same transaction.
// - Notes are append-only. Resolving and dismissing need a code and a note;
//   reopening needs a reason and is audited.
// - A reader sees only the case types whose sources their role can see.

export const CASE_NOT_FOUND = "We couldn't find that case.";
const STALE = "This case changed since you loaded it. Reload and try again.";
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newReference = () =>
  `FKC-${Array.from({ length: 8 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join("")}`;

const SOURCE_ID: Record<CaseType, RegExp> = {
  order_payment: /^FKO-[A-Z0-9]{8}$/,
  order_issue: /^FKO-[A-Z0-9]{8}$/,
  service_booking: /^FK-SVC-[A-Z0-9]{8}$/,
  payout: /^fkp_[0-9a-f]{24}$/,
  notification_delivery: /^[0-9a-f]{24}$/,
  account: /^[0-9a-f]{24}$/,
};

export const sourceKeyOf = (type: CaseType, id: string) => `${type}:${id}`;

async function db() {
  const database = await getDb();
  return {
    cases: database.collection<AdminCaseDoc>(COLLECTIONS.adminCases),
    users: database.collection<UserDoc>(COLLECTIONS.users),
    memberships: database.collection<AdminMembershipDoc>(COLLECTIONS.adminMemberships),
    orders: database.collection<OrderDoc>(COLLECTIONS.orders),
    bookings: database.collection<ServiceBookingDoc>(COLLECTIONS.serviceBookings),
    payouts: database.collection<PayoutDoc>(COLLECTIONS.payouts),
    deliveries: database.collection<NotificationDeliveryDoc>(COLLECTIONS.notificationDeliveries),
  };
}

// --- who may see and do what --------------------------------------------------------------

/** The case types this admin may see: cases.read plus the capability that shows the source. */
export function visibleCaseTypes(access: AdminAccess): CaseType[] {
  if (!access.can("admin.cases.read")) return [];
  return CASE_TYPES.filter((type) => access.can(CASE_SOURCE_CAPABILITY[type]));
}

const canSee = (access: AdminAccess, type: CaseType) =>
  access.can("admin.cases.read") && access.can(CASE_SOURCE_CAPABILITY[type]);

export function casePermissions(
  access: AdminAccess,
  doc: Pick<AdminCaseDoc, "type" | "assigneeUserId">,
): CasePermissions {
  if (!canSee(access, doc.type)) return { work: false, note: false, assign: false };
  const assignAny = access.can("admin.cases.assign");
  const manage = access.can("admin.cases.manage");
  const mine = !doc.assigneeUserId || doc.assigneeUserId.equals(access.user._id);
  return { work: assignAny || (manage && mine), note: assignAny || manage, assign: assignAny };
}

const roleCan = (role: AdminRole, capability: AdminCapability) => ROLE_CAPABILITIES[role].includes(capability);

const roleMayWork = (role: AdminRole, type: CaseType) =>
  roleCan(role, "admin.cases.read") &&
  roleCan(role, CASE_SOURCE_CAPABILITY[type]) &&
  (roleCan(role, "admin.cases.manage") || roleCan(role, "admin.cases.assign"));

/** Admins a case of this type can be assigned to: active, verified accounts whose role may work it. */
export async function listAssignees(type: CaseType): Promise<Assignee[]> {
  const { users, memberships } = await db();
  const roles = ADMIN_ROLES.filter((role) => roleMayWork(role, type));
  const rootIds = [...getAdminUserIds()];
  const granted = await memberships
    .find({ status: "active", role: { $in: roles } }, { projection: { userId: 1, role: 1 } })
    .limit(200)
    .toArray();
  const roleOf = new Map<string, AdminRole>(granted.map((m) => [m.userId.toHexString(), m.role]));
  // root admins are Super Admins (they may work every type)
  if (roles.includes("super_admin")) for (const id of rootIds) roleOf.set(id, "super_admin");
  if (!roleOf.size) return [];
  const docs = await users
    .find(
      {
        _id: { $in: [...roleOf.keys()].map((id) => new ObjectId(id)) },
        status: "active",
        phoneVerifiedAt: { $ne: null },
      },
      { projection: { fullName: 1 } },
    )
    .toArray();
  return docs
    .map((u) => ({ id: u._id.toHexString(), name: u.fullName, role: roleOf.get(u._id.toHexString())! }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- sources ------------------------------------------------------------------------------

type SourceCheck = { eligible: boolean; title: string; priority: CasePriority; info: CaseSourceInfo };

const date = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const humanize = (value: string) => value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Reads the source live, with a projection of safe fields only. Null when
 * it doesn't exist. Never returns contact details, bank numbers, recipient
 * codes or provider payloads.
 */
async function checkSource(type: CaseType, id: string): Promise<SourceCheck | null> {
  const c = await db();
  switch (type) {
    case "order_payment":
    case "order_issue": {
      const order = await c.orders.findOne(
        { number: id },
        {
          projection: {
            number: 1,
            reviewIssue: 1,
            issue: 1,
            paymentStatus: 1,
            fulfillmentStatus: 1,
            totalKobo: 1,
            paidKobo: 1,
          },
        },
      );
      if (!order) return null;
      if (type === "order_payment") {
        const category = issueCategory(order.reviewIssue);
        return {
          eligible: typeof order.reviewIssue === "string",
          title: `Order ${order.number}: ${EXCEPTION_CATEGORY_LABELS[category].toLowerCase()}`,
          priority: "high",
          info: {
            label: `Order ${order.number}`,
            href: "/admin/exceptions?kind=orders",
            facts: [
              ["Flag", order.reviewIssue ? sanitizeIssue(order.reviewIssue) : "No longer flagged"],
              ["Payment", humanize(order.paymentStatus)],
              ["Expected", formatKobo(order.totalKobo)],
              ["Paid (recorded)", order.paidKobo > 0 ? formatKobo(order.paidKobo) : "Nothing recorded"],
            ],
          },
        };
      }
      return {
        eligible: !!order.issue?.reportedAt,
        title: `Order ${order.number}: problem reported by the buyer`,
        priority: "normal",
        info: {
          label: `Order ${order.number}`,
          href: `/admin/issues/${order.number}`,
          facts: [
            ["Reported", date(order.issue?.reportedAt)],
            ["Issue", order.issue ? (order.issue.closedAt ? "Closed" : "Open") : "None"],
            ["Payment", humanize(order.paymentStatus)],
            ["Fulfilment", humanize(order.fulfillmentStatus)],
          ],
        },
      };
    }
    case "service_booking": {
      const booking = await c.bookings.findOne(
        { reference: id },
        { projection: { reference: 1, status: 1, paymentStatus: 1, amountKobo: 1, paidKobo: 1, reviewIssue: 1 } },
      );
      if (!booking) return null;
      const category = issueCategory(booking.reviewIssue);
      return {
        eligible: typeof booking.reviewIssue === "string",
        title: `Booking ${booking.reference}: ${EXCEPTION_CATEGORY_LABELS[category].toLowerCase()}`,
        priority: "high",
        info: {
          label: `Booking ${booking.reference}`,
          href: "/admin/exceptions?kind=bookings",
          facts: [
            ["Flag", booking.reviewIssue ? sanitizeIssue(booking.reviewIssue) : "No longer flagged"],
            ["Status", humanize(booking.status)],
            ["Payment", humanize(booking.paymentStatus)],
            ["Expected", booking.amountKobo === null ? "Not priced" : formatKobo(booking.amountKobo)],
            ["Paid (recorded)", booking.paidKobo > 0 ? formatKobo(booking.paidKobo) : "Nothing recorded"],
          ],
        },
      };
    }
    case "payout": {
      // never recipientCode, transfer codes or provider details
      const payout = await c.payouts.findOne(
        { reference: id },
        {
          projection: {
            reference: 1,
            status: 1,
            providerStatus: 1,
            issue: 1,
            amountKobo: 1,
            bankName: 1,
            accountNumberLast4: 1,
          },
        },
      );
      if (!payout) return null;
      const category = issueCategory(payout.issue);
      return {
        eligible: typeof payout.issue === "string" || payout.status === "failed" || payout.providerStatus === "unknown",
        title: `Payout ${payout.reference.slice(-8)}: ${payout.issue ? EXCEPTION_CATEGORY_LABELS[category].toLowerCase() : humanize(payout.status).toLowerCase()}`,
        priority: "high",
        info: {
          label: `Payout ${payout.reference}`,
          href: "/admin/exceptions?kind=payouts",
          facts: [
            ["Flag", payout.issue ? sanitizeIssue(payout.issue) : "Not flagged"],
            ["Status", humanize(payout.status)],
            ["Provider outcome", payout.providerStatus === "unknown" ? "Unknown" : "Known"],
            ["Amount", formatKobo(payout.amountKobo)],
            ["Bank", `${payout.bankName} ••••${String(payout.accountNumberLast4 ?? "").slice(-4)}`],
          ],
        },
      };
    }
    case "notification_delivery": {
      const delivery = await c.deliveries.findOne(
        { _id: new ObjectId(id) },
        { projection: { channel: 1, state: 1, attempts: 1, lastFailure: 1, updatedAt: 1 } },
      );
      if (!delivery) return null;
      return {
        eligible: delivery.state === "failed" || delivery.state === "exhausted",
        title: `${humanize(delivery.channel)} delivery ${humanize(delivery.state).toLowerCase()}`,
        priority: "normal",
        info: {
          label: `${humanize(delivery.channel)} delivery`,
          href: "/admin/exceptions?kind=deliveries",
          facts: [
            ["State", humanize(delivery.state)],
            ["Attempts", String(delivery.attempts)],
            ["Last failure", delivery.lastFailure ? delivery.lastFailure.slice(0, 80) : "—"],
            ["Updated", date(delivery.updatedAt)],
          ],
        },
      };
    }
    case "account": {
      const user = await c.users.findOne(
        { _id: new ObjectId(id) },
        { projection: { fullName: 1, role: 1, status: 1 } },
      );
      if (!user) return null;
      return {
        eligible: true,
        title: `Account: ${user.fullName}`.slice(0, CASE_TEXT_LIMITS.title.max),
        priority: "normal",
        info: {
          label: user.fullName,
          href: `/admin/users/${id}`,
          facts: [
            ["Role", ROLE_LABELS[user.role] ?? humanize(user.role)],
            ["Status", ACCOUNT_STATUS_LABELS[user.status as AccountStatus] ?? humanize(user.status)],
          ],
        },
      };
    }
  }
}

/** The open case for each of these sources (for the exception lists' links). */
export async function openCaseLinks(type: CaseType, ids: string[]): Promise<Map<string, ExceptionCaseLink>> {
  if (!ids.length) return new Map();
  const { cases } = await db();
  const docs = await cases
    .find(
      { sourceKey: { $in: ids.map((id) => sourceKeyOf(type, id)) } },
      { projection: { reference: 1, status: 1, source: 1 } },
    )
    .toArray();
  return new Map(docs.map((d) => [d.source.id, { reference: d.reference, status: d.status }]));
}

// --- reading ------------------------------------------------------------------------------

async function namesOf(ids: Array<ObjectId | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.flatMap((id) => (id ? [id.toHexString()] : [])))].map((id) => new ObjectId(id));
  if (!unique.length) return new Map();
  const { users } = await db();
  const docs = await users.find({ _id: { $in: unique } }, { projection: { fullName: 1 } }).toArray();
  return new Map(docs.map((u) => [u._id.toHexString(), u.fullName]));
}

function toSummary(doc: AdminCaseDoc, names: Map<string, string>): CaseSummary {
  const assignee = doc.assigneeUserId?.toHexString() ?? null;
  return {
    reference: doc.reference,
    type: doc.type,
    sourceId: doc.source.id,
    title: doc.title,
    priority: doc.priority,
    status: doc.status,
    assignee: assignee ? { id: assignee, name: names.get(assignee) ?? "Former admin" } : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    resolvedAt: doc.resolution?.at.toISOString() ?? null,
  };
}

export type CaseFilters = {
  state: "open" | "closed";
  status: CaseStatus | null;
  type: CaseType | null;
  priority: CasePriority | null;
  /** "me", "none" or an admin's user id */
  assignee: string | null;
};

export function parseCaseFilters(params: URLSearchParams): CaseFilters {
  const fieldErrors: Record<string, string> = {};
  const state = params.get("state") || "open";
  const status = params.get("status") || null;
  const type = params.get("type") || null;
  const priority = params.get("priority") || null;
  const assignee = params.get("assignee")?.trim().toLowerCase() || null;
  if (state !== "open" && state !== "closed") fieldErrors.state = "Choose open or closed.";
  if (status !== null && !isCaseStatus(status)) fieldErrors.status = "Unknown status.";
  if (type !== null && !isCaseType(type)) fieldErrors.type = "Unknown case type.";
  if (priority !== null && !isCasePriority(priority)) fieldErrors.priority = "Unknown priority.";
  if (assignee !== null && assignee !== "me" && assignee !== "none" && !/^[0-9a-f]{24}$/.test(assignee))
    fieldErrors.assignee = "Unknown assignee.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the filters.", fieldErrors);
  return {
    state: state as CaseFilters["state"],
    status: status as CaseStatus | null,
    type: type as CaseType | null,
    priority: priority as CasePriority | null,
    assignee,
  };
}

function caseQuery(access: AdminAccess, filters: CaseFilters): Filter<AdminCaseDoc> | null {
  const visible = visibleCaseTypes(access);
  if (filters.type && !visible.includes(filters.type)) return null;
  const query: Filter<AdminCaseDoc> = { open: filters.state === "open" };
  query.type = filters.type ?? { $in: visible };
  if (filters.status) query.status = filters.status;
  if (filters.priority) query.priorityRank = PRIORITY_RANK[filters.priority];
  if (filters.assignee === "me") query.assigneeUserId = access.user._id;
  else if (filters.assignee === "none") query.assigneeUserId = null;
  else if (filters.assignee) query.assigneeUserId = new ObjectId(filters.assignee);
  return query;
}

/** Open cases most urgent then oldest first; closed ones most recently changed first. */
export async function listCases(
  access: AdminAccess,
  filters: CaseFilters,
  page: number,
  pageSize = ADMIN_PAGE_SIZE,
): Promise<CasePage> {
  const query = caseQuery(access, filters);
  if (!query) return { cases: [], page, hasMore: false };
  const { cases } = await db();
  const sort: Sort = filters.state === "open" ? { priorityRank: -1, createdAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
  const docs = await cases
    .find(query, { projection: { notes: 0 } })
    .sort(sort)
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  const shown = docs.slice(0, pageSize);
  const names = await namesOf(shown.map((d) => d.assigneeUserId));
  return { cases: shown.map((d) => toSummary(d, names)), page, hasMore: docs.length > pageSize };
}

/** Open, high-or-urgent and unassigned counts over the case types this admin may see. */
export async function countCases(access: AdminAccess): Promise<CaseCounts> {
  const visible = visibleCaseTypes(access);
  if (!visible.length) return { open: 0, urgent: 0, unassigned: 0 };
  const { cases } = await db();
  const base: Filter<AdminCaseDoc> = { open: true, type: { $in: visible } };
  const [open, urgent, unassigned] = await Promise.all([
    cases.countDocuments(base),
    cases.countDocuments({ ...base, priorityRank: { $gte: PRIORITY_RANK.high } }),
    cases.countDocuments({ ...base, assigneeUserId: null }),
  ]);
  return { open, urgent, unassigned };
}

async function findVisible(access: AdminAccess, reference: string): Promise<AdminCaseDoc> {
  if (!/^FKC-[A-Z0-9]{8}$/.test(reference)) throw new HttpError(404, CASE_NOT_FOUND);
  const { cases } = await db();
  const doc = await cases.findOne({ reference });
  // a case of a type the reader can't see doesn't exist for them
  if (!doc || !canSee(access, doc.type)) throw new HttpError(404, CASE_NOT_FOUND);
  return doc;
}

export async function getCase(access: AdminAccess, reference: string): Promise<CaseResponse> {
  const doc = await findVisible(access, reference);
  const [names, source, history] = await Promise.all([
    namesOf([doc.assigneeUserId, doc.createdBy, doc.resolution?.by, ...doc.notes.map((n) => n.authorUserId)]),
    checkSource(doc.type, doc.source.id),
    auditFor("case", doc.reference),
  ]);
  const permissions = casePermissions(access, doc);
  const detail: CaseDetail = {
    ...toSummary(doc, names),
    version: doc.version,
    createdByName: names.get(doc.createdBy.toHexString()) ?? null,
    notes: doc.notes.map((n) => ({
      id: n.id,
      authorName: names.get(n.authorUserId.toHexString()) ?? null,
      body: n.body,
      at: n.at.toISOString(),
    })),
    resolution: doc.resolution
      ? {
          code: doc.resolution.code,
          note: doc.resolution.note,
          byName: names.get(doc.resolution.by.toHexString()) ?? null,
          at: doc.resolution.at.toISOString(),
        }
      : null,
    source: source?.info ?? null,
    history,
  };
  return {
    case: detail,
    permissions,
    assignees: permissions.assign || permissions.work ? await listAssignees(doc.type) : [],
  };
}

// --- creating -----------------------------------------------------------------------------

const textOf = (
  value: unknown,
  limits: { min: number; max: number },
  empty: string,
  field: string,
  errors: Record<string, string>,
) => {
  const text = typeof value === "string" ? cleanText(value, true) : "";
  const error = validateLimitedText(text, limits, empty);
  if (error) errors[field] = error;
  return text;
};

const unknownFields = (body: Record<string, unknown>, allowed: string[], errors: Record<string, string>) => {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) errors[unknown[0]] = "This field can't be sent.";
};

const raise = (errors: Record<string, string>) => {
  if (Object.keys(errors).length) throw new HttpError(400, "Please correct the highlighted fields.", errors);
};

export function parseCreateCase(body: Record<string, unknown>): CreateCaseRequest {
  const errors: Record<string, string> = {};
  unknownFields(body, ["type", "sourceId", "priority", "title", "note"], errors);
  const type = body.type;
  if (!isCaseType(type)) errors.type = "Choose what the case is about.";
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  if (isCaseType(type) && !SOURCE_ID[type].test(sourceId)) errors.sourceId = "That reference doesn't look right.";
  if (body.priority !== undefined && !isCasePriority(body.priority)) errors.priority = "Choose a priority.";
  const title =
    body.title === undefined || body.title === ""
      ? undefined
      : textOf(body.title, CASE_TEXT_LIMITS.title, "Give the case a title.", "title", errors).replace(/\n+/g, " ");
  const note =
    body.note === undefined || body.note === ""
      ? undefined
      : textOf(body.note, CASE_TEXT_LIMITS.note, "Write a note.", "note", errors);
  raise(errors);
  return { type: type as CaseType, sourceId, priority: body.priority as CasePriority | undefined, title, note };
}

/** Opens a case about a source. Only a case is written: the source is read, never changed. */
export async function createCase(access: AdminAccess, request: CreateCaseRequest): Promise<CaseResponse> {
  if (!canSee(access, request.type) || !(access.can("admin.cases.manage") || access.can("admin.cases.assign")))
    throw new HttpError(403, "Your admin role can't open this kind of case.");
  const source = await checkSource(request.type, request.sourceId);
  if (!source) throw new HttpError(404, "We couldn't find that record.");
  if (!source.eligible) throw new HttpError(409, "That record isn't flagged, so there's nothing to open a case about.");
  const key = sourceKeyOf(request.type, request.sourceId);
  const { cases } = await db();
  const priority = request.priority ?? source.priority;

  for (let attempt = 0; ; attempt += 1) {
    const now = new Date();
    const doc: AdminCaseDoc = {
      _id: new ObjectId(),
      reference: newReference(),
      type: request.type,
      source: { type: request.type, id: request.sourceId },
      sourceKey: key,
      title: request.title ?? source.title.slice(0, CASE_TEXT_LIMITS.title.max),
      priority,
      priorityRank: PRIORITY_RANK[priority],
      status: "open",
      open: true,
      assigneeUserId: null,
      notes: request.note
        ? [{ id: new ObjectId().toHexString(), authorUserId: access.user._id, body: request.note, at: now }]
        : [],
      resolution: null,
      createdBy: access.user._id,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    try {
      await inTransaction(async (session) => {
        await cases.insertOne(doc, { session });
        await recordAudit(
          {
            actorUserId: access.user._id,
            action: "case.create",
            target: { type: "case", id: doc.reference },
            reason: null,
            from: null,
            to: `${request.type}:${request.sourceId}`,
          },
          session,
          now,
        );
      });
      return getCase(access, doc.reference);
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
      const existing = await cases.findOne({ sourceKey: key }, { projection: { reference: 1 } });
      if (existing)
        throw new HttpError(409, `Case ${existing.reference} is already open for this record.`, {
          reference: existing.reference,
        });
      // a reference collision: try another
      if (attempt >= 2) throw error;
    }
  }
}

// --- changing -----------------------------------------------------------------------------

export function parseCaseChange(body: Record<string, unknown>): CaseChangeRequest {
  const errors: Record<string, string> = {};
  const action = body.action;
  const expectedVersion = body.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1)
    errors.expectedVersion = "Reload the case and try again.";
  const version = expectedVersion as number;
  switch (action) {
    case "assign": {
      unknownFields(body, ["action", "assigneeId", "expectedVersion"], errors);
      const id = body.assigneeId;
      if (id !== null && (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id))) errors.assigneeId = "Choose an admin.";
      raise(errors);
      return { action, assigneeId: id as string | null, expectedVersion: version };
    }
    case "priority":
      unknownFields(body, ["action", "priority", "expectedVersion"], errors);
      if (!isCasePriority(body.priority)) errors.priority = "Choose a priority.";
      raise(errors);
      return { action, priority: body.priority as CasePriority, expectedVersion: version };
    case "status":
      unknownFields(body, ["action", "status", "expectedVersion"], errors);
      if (!isWorkingStatus(body.status)) errors.status = "Choose a status. Use resolve or dismiss to close a case.";
      raise(errors);
      return { action, status: body.status as never, expectedVersion: version };
    case "note": {
      unknownFields(body, ["action", "note", "expectedVersion"], errors);
      const note = textOf(body.note, CASE_TEXT_LIMITS.note, "Write a note.", "note", errors);
      raise(errors);
      return { action, note, expectedVersion: version };
    }
    case "resolve":
    case "dismiss": {
      unknownFields(body, ["action", "code", "note", "expectedVersion"], errors);
      if (!isResolutionCode(body.code)) errors.code = "Choose an outcome.";
      const note = textOf(
        body.note,
        CASE_TEXT_LIMITS.resolutionNote,
        "Write an internal note on the outcome.",
        "note",
        errors,
      );
      raise(errors);
      return { action, code: body.code as never, note, expectedVersion: version };
    }
    case "reopen": {
      unknownFields(body, ["action", "reason", "expectedVersion"], errors);
      const reason = textOf(
        body.reason,
        CASE_TEXT_LIMITS.reopenReason,
        "Say why the case is being reopened.",
        "reason",
        errors,
      );
      raise(errors);
      return { action, reason, expectedVersion: version };
    }
    default:
      errors.action = "Unknown action.";
      raise(errors);
      throw new Error("unreachable");
  }
}

type Planned = {
  update: UpdateFilter<AdminCaseDoc>;
  /** extra conditions the stored case must still meet */
  guard?: Filter<AdminCaseDoc>;
  audit: {
    action: Parameters<typeof recordAudit>[0]["action"];
    reason?: string | null;
    from?: string | null;
    to?: string | null;
  };
};

function plan(
  access: AdminAccess,
  doc: AdminCaseDoc,
  request: CaseChangeRequest,
  now: Date,
  assignees: Assignee[],
): Planned {
  const perms = casePermissions(access, doc);
  const closed = isClosedStatus(doc.status);
  const me = access.user._id;
  const set = (fields: Partial<AdminCaseDoc>) =>
    ({ $set: { ...fields, updatedAt: now }, $inc: { version: 1 } }) as UpdateFilter<AdminCaseDoc>;
  if (closed && request.action !== "reopen") throw new HttpError(409, "This case is closed. Reopen it first.");

  switch (request.action) {
    case "note":
      if (!perms.note) throw new HttpError(403, "Your admin role can't add notes to this case.");
      if (doc.notes.length >= MAX_CASE_NOTES)
        throw new HttpError(409, "This case has reached its note limit. Open a follow-up case instead.");
      return {
        update: {
          $push: { notes: { id: new ObjectId().toHexString(), authorUserId: me, body: request.note, at: now } },
          $set: { updatedAt: now },
          $inc: { version: 1 },
        },
        guard: { [`notes.${MAX_CASE_NOTES - 1}`]: { $exists: false } },
        audit: { action: "case.note" },
      };
    case "assign": {
      const target = request.assigneeId ? new ObjectId(request.assigneeId) : null;
      const current = doc.assigneeUserId;
      if ((current === null && target === null) || (current && target && current.equals(target)))
        throw new HttpError(409, "The case is already assigned that way.");
      const selfService =
        access.can("admin.cases.manage") &&
        ((current === null && target?.equals(me)) || (current?.equals(me) && target === null));
      if (!perms.assign && !selfService)
        throw new HttpError(403, "Your admin role can only take unassigned cases or release your own.");
      if (target && !assignees.some((a) => a.id === target.toHexString()))
        throw new HttpError(400, "Please correct the highlighted fields.", {
          assigneeId: "That admin can't work this kind of case.",
        });
      return {
        update: set({ assigneeUserId: target }),
        audit: { action: "case.assign", from: current?.toHexString() ?? null, to: target?.toHexString() ?? null },
      };
    }
    case "priority":
      if (!perms.work) throw new HttpError(403, "This case is assigned to someone else.");
      if (request.priority === doc.priority)
        throw new HttpError(409, `The case is already ${CASE_PRIORITY_LABELS[doc.priority].toLowerCase()} priority.`);
      return {
        update: set({ priority: request.priority, priorityRank: PRIORITY_RANK[request.priority] }),
        audit: { action: "case.priority", from: doc.priority, to: request.priority },
      };
    case "status":
      if (!perms.work) throw new HttpError(403, "This case is assigned to someone else.");
      if (request.status === doc.status)
        throw new HttpError(409, `The case is already ${CASE_STATUS_LABELS[doc.status].toLowerCase()}.`);
      return {
        update: set({ status: request.status }),
        audit: { action: "case.status", from: doc.status, to: request.status },
      };
    case "resolve":
    case "dismiss": {
      if (!perms.work) throw new HttpError(403, "This case is assigned to someone else.");
      const to: CaseStatus = request.action === "resolve" ? "resolved" : "dismissed";
      return {
        update: {
          $set: {
            status: to,
            open: false,
            resolution: { code: request.code, note: request.note, by: me, at: now },
            updatedAt: now,
          },
          $unset: { sourceKey: "" },
          $inc: { version: 1 },
        },
        audit: {
          action: request.action === "resolve" ? "case.resolve" : "case.dismiss",
          reason: request.note,
          from: doc.status,
          to: `${to}:${request.code}`,
        },
      };
    }
    case "reopen":
      if (!closed) throw new HttpError(409, "This case is already open.");
      // same rule as working it: the assignee, anyone on an unassigned case, or a case assigner
      if (!perms.work) throw new HttpError(403, "This case is assigned to someone else.");
      return {
        update: set({ status: "open", open: true, sourceKey: sourceKeyOf(doc.type, doc.source.id), resolution: null }),
        audit: { action: "case.reopen", reason: request.reason, from: doc.status, to: "open" },
      };
  }
}

/** Applies one change against the version the admin saw, with its audit record, in one transaction. */
export async function changeCase(
  access: AdminAccess,
  reference: string,
  request: CaseChangeRequest,
): Promise<CaseResponse> {
  const doc = await findVisible(access, reference);
  if (doc.version !== request.expectedVersion) throw new HttpError(409, STALE);
  const assignees = request.action === "assign" && request.assigneeId ? await listAssignees(doc.type) : [];
  const { cases } = await db();
  try {
    await inTransaction(async (session) => {
      const now = new Date();
      const planned = plan(access, doc, request, now, assignees);
      const result = await cases.updateOne(
        { _id: doc._id, version: request.expectedVersion, ...planned.guard },
        planned.update,
        { session },
      );
      if (result.modifiedCount !== 1) throw new HttpError(409, STALE);
      await recordAudit(
        {
          actorUserId: access.user._id,
          action: planned.audit.action,
          target: { type: "case", id: doc.reference },
          reason: planned.audit.reason ?? null,
          from: planned.audit.from ?? null,
          to: planned.audit.to ?? null,
        },
        session,
        now,
      );
    });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const other = await cases.findOne(
        { sourceKey: sourceKeyOf(doc.type, doc.source.id) },
        { projection: { reference: 1 } },
      );
      throw new HttpError(
        409,
        other ? `Case ${other.reference} is already open for this record, so this one can't be reopened.` : STALE,
        other ? { reference: other.reference } : undefined,
      );
    }
    throw error;
  }
  return getCase(access, reference);
}
