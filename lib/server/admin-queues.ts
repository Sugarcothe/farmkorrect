import "server-only";
import type { Filter } from "mongodb";
import {
  ADMIN_PAGE_SIZE,
  type AdminSummary,
  type AuditEntry,
  type ExceptionKind,
  type ExceptionPage,
  type IssueCase,
  type IssuePage,
} from "@/lib/admin/types";
import { validateResolutionNote } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";
import type { AdminAccess } from "./admin";
import { countSuspendedAccounts } from "./admin-accounts";
import { auditFor, countAuditActions, listAudit } from "./admin-audit";
import { countCases, openCaseLinks } from "./admin-cases";
import { countPendingCredentials } from "./admin-credentials";
import { bookingOutcome, issueCategory, orderOutcome, payoutOutcome, sanitizeIssue } from "./admin-flags";
import { countPendingReviews } from "./admin-reviews";
import { getDb } from "./db";
import { HttpError } from "./http";
import {
  COLLECTIONS,
  type FulfillmentDoc,
  type NotificationDeliveryDoc,
  type NotificationDoc,
  type OrderDoc,
  type PayoutDoc,
  type ServiceBookingDoc,
  type ServiceRefundDoc,
  type UserDoc,
} from "./models";
import { closeIssue } from "./orders";

// The admin dashboard, the order-issue queue and the read-only list of
// operational exceptions. Everything is a page of small summaries built
// here: no whole documents, no recipient codes, provider payloads, contact
// details or full bank numbers. The only change made from here is closing
// an order issue, through orders.ts closeIssue (ledger and notifications
// follow from it); payouts, refunds, payments and the ledger are never
// touched.

async function collections() {
  const db = await getDb();
  return {
    orders: db.collection<OrderDoc>(COLLECTIONS.orders),
    payouts: db.collection<PayoutDoc>(COLLECTIONS.payouts),
    bookings: db.collection<ServiceBookingDoc>(COLLECTIONS.serviceBookings),
    refunds: db.collection<ServiceRefundDoc>(COLLECTIONS.serviceRefunds),
    deliveries: db.collection<NotificationDeliveryDoc>(COLLECTIONS.notificationDeliveries),
    notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
    fulfillments: db.collection<FulfillmentDoc>(COLLECTIONS.fulfillments),
  };
}

export const OPEN_ISSUE: Filter<OrderDoc> = { "issue.reportedAt": { $type: "date" }, "issue.closedAt": null };
const CLOSED_ISSUE: Filter<OrderDoc> = { "issue.reportedAt": { $type: "date" }, "issue.closedAt": { $type: "date" } };
export const FLAGGED_ORDER: Filter<OrderDoc> = { reviewIssue: { $type: "string" } };
export const FLAGGED_PAYOUT: Filter<PayoutDoc> = { issue: { $type: "string" } };
export const FLAGGED_BOOKING: Filter<ServiceBookingDoc> = { reviewIssue: { $type: "string" } };
export const FAILED_DELIVERY: Filter<NotificationDeliveryDoc> = { state: { $in: ["failed", "exhausted"] } };

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * The dashboard counts this admin's role covers. Each count is read on its
 * own: one that fails comes back null (shown as an error), never as 0, and
 * the others still load.
 */
export async function getAdminSummary(access: AdminAccess): Promise<AdminSummary> {
  const { orders, payouts, bookings, deliveries } = await collections();
  const jobs: Array<[keyof AdminSummary, () => Promise<unknown>]> = [];
  const add = (key: keyof AdminSummary, allowed: boolean, read: () => Promise<unknown>) => {
    if (allowed) jobs.push([key, read]);
  };
  add("pendingCredentials", access.can("admin.credentials.review"), countPendingCredentials);
  add("openIssues", access.can("admin.order_issues.read"), () => orders.countDocuments(OPEN_ISSUE));
  add("reviewsToModerate", access.can("admin.reviews.moderate"), countPendingReviews);
  const exceptions = access.can("admin.exceptions.read");
  add("flaggedOrders", exceptions, () => orders.countDocuments(FLAGGED_ORDER));
  add("flaggedPayouts", exceptions, () => payouts.countDocuments(FLAGGED_PAYOUT));
  add("flaggedBookings", exceptions, () => bookings.countDocuments(FLAGGED_BOOKING));
  add("failedDeliveries", access.can("admin.deliveries.read"), () => deliveries.countDocuments(FAILED_DELIVERY));
  if (access.can("admin.cases.read")) {
    // one read for the three case counts
    const counts = countCases(access);
    counts.catch(() => undefined);
    add("openCases", true, async () => (await counts).open);
    add("urgentCases", true, async () => (await counts).urgent);
    add("unassignedCases", true, async () => (await counts).unassigned);
  }
  add("suspendedAccounts", access.can("admin.users.read"), countSuspendedAccounts);
  add("recentAccountActions", access.can("admin.users.read"), () =>
    countAuditActions(["user.suspend", "user.reactivate"], new Date(Date.now() - WEEK_MS)),
  );
  add("recentActions", access.can("admin.audit.read"), async () =>
    (await listAudit({ action: null, targetType: null, targetId: null, actorUserId: null }, 1, 5)).entries,
  );

  const results = await Promise.allSettled(jobs.map(([, read]) => read()));
  const summary: Record<string, unknown> = {};
  results.forEach((result, i) => {
    const key = jobs[i][0];
    if (result.status === "fulfilled") summary[key] = result.value;
    else {
      summary[key] = null;
      console.error(`[admin] summary count ${key} failed`, (result.reason as Error)?.name ?? "error");
    }
  });
  return summary as AdminSummary;
}

// --- order issues -------------------------------------------------------------------

const ORDER_NUMBER = /^FKO-[A-Z0-9]{8}$/;
const ISSUE_NOT_FOUND = "We couldn't find a reported problem for that order.";

const ISSUE_PROJECTION = {
  number: 1,
  buyerUserId: 1,
  sellerUserId: 1,
  buyerName: 1,
  sellerName: 1,
  issue: 1,
  totalKobo: 1,
  promotion: 1,
  paymentStatus: 1,
  fulfillmentStatus: 1,
  refundedKobo: 1,
  refundPendingKobo: 1,
} as const;

/** Whether each order's earning is on hold in the ledger right now. */
async function heldEarnings(numbers: string[]): Promise<Set<string>> {
  if (!numbers.length) return new Set();
  const { fulfillments } = await collections();
  const held = await fulfillments
    .find({ sourceType: "order", sourceId: { $in: numbers }, disputedAt: { $type: "date" } }, { projection: { sourceId: 1 } })
    .toArray();
  return new Set(held.map((f) => f.sourceId));
}

function toIssueCase(order: OrderDoc, held: Set<string>): IssueCase {
  const issue = order.issue!;
  return {
    orderNumber: order.number,
    buyerName: order.buyerName,
    sellerName: order.sellerName,
    reportedAt: issue.reportedAt.toISOString(),
    note: issue.note,
    open: issue.closedAt === null,
    closedAt: issue.closedAt?.toISOString() ?? null,
    resolutionNote: issue.resolution?.note ?? null,
    totalKobo: order.totalKobo,
    discountKobo: order.promotion?.discountKobo ?? 0,
    promotionLabel: order.promotion ? (order.promotion.code ? `Code ${order.promotion.code}` : order.promotion.name) : null,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    refundedKobo: order.refundedKobo,
    refundPendingKobo: order.refundPendingKobo,
    earningHeld: held.has(order.number),
  };
}

/** Open issues oldest first, or closed ones newest first. */
export async function listIssues(state: "open" | "closed", page: number, pageSize = ADMIN_PAGE_SIZE): Promise<IssuePage> {
  const { orders } = await collections();
  const docs = await orders
    .find(state === "open" ? OPEN_ISSUE : CLOSED_ISSUE, { projection: ISSUE_PROJECTION })
    .sort(state === "open" ? { "issue.reportedAt": 1, _id: 1 } : { "issue.closedAt": -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  const shown = docs.slice(0, pageSize);
  const held = await heldEarnings(shown.map((o) => o.number));
  return { cases: shown.map((o) => toIssueCase(o, held)), page, hasMore: docs.length > pageSize };
}

export async function getIssueCase(number: string): Promise<{ case: IssueCase; history: AuditEntry[] } | null> {
  if (!ORDER_NUMBER.test(number)) return null;
  const { orders } = await collections();
  const order = await orders.findOne({ number, issue: { $ne: null } }, { projection: ISSUE_PROJECTION });
  if (!order) return null;
  return { case: toIssueCase(order, await heldEarnings([number])), history: await auditFor("order", number) };
}

export function parseCloseIssue(body: Record<string, unknown>): string {
  const fieldErrors: Record<string, string> = {};
  const unknown = Object.keys(body).filter((k) => !["note", "confirmed"].includes(k));
  if (unknown.length) fieldErrors[unknown[0]] = "This field can't be sent.";
  const note = typeof body.note === "string" ? cleanText(body.note, true) : "";
  const noteError = validateResolutionNote(note);
  if (noteError) fieldErrors.note = noteError;
  if (body.confirmed !== true)
    fieldErrors.confirmed = "Confirm the case is resolved and any refund due was already handled.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
  return note;
}

/**
 * Closes an open issue for an admin. This releases the seller's held
 * earning; it never refunds anyone.
 */
export async function closeIssueAsAdmin(admin: UserDoc, number: string, note: string): Promise<IssueCase> {
  if (!ORDER_NUMBER.test(number)) throw new HttpError(404, ISSUE_NOT_FOUND);
  const { orders } = await collections();
  const order = await orders.findOne({ number, issue: { $ne: null } }, { projection: ISSUE_PROJECTION });
  if (!order) throw new HttpError(404, ISSUE_NOT_FOUND);
  if (order.buyerUserId.equals(admin._id) || order.sellerUserId.equals(admin._id))
    throw new HttpError(403, "You can't close an issue on your own order.");
  if (order.issue!.closedAt) throw new HttpError(409, "This issue has already been closed.");
  const closed = await closeIssue(number, { adminUserId: admin._id, note });
  if (!closed) throw new HttpError(409, "This issue has already been closed.");
  return toIssueCase(closed, await heldEarnings([number]));
}

// --- operational exceptions (read only) ------------------------------------------------

// Every list is read only: there is no retry, refund, payout or ledger
// action anywhere in the exceptions view. The reason text is sanitized,
// expected and observed amounts are kept apart (an observed amount that was
// never recorded is null, not 0), and each row links to its open case.

const recorded = (kobo: number) => (kobo > 0 ? kobo : null);

export async function listExceptions(kind: ExceptionKind, page: number, pageSize = ADMIN_PAGE_SIZE): Promise<ExceptionPage> {
  const { orders, payouts, bookings, refunds, deliveries, notifications } = await collections();
  const skip = (page - 1) * pageSize;
  if (kind === "orders") {
    const docs = await orders
      .find(FLAGGED_ORDER, {
        projection: { number: 1, reviewIssue: 1, paymentStatus: 1, fulfillmentStatus: 1, totalKobo: 1, paidKobo: 1, updatedAt: 1 },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(pageSize + 1)
      .toArray();
    const shown = docs.slice(0, pageSize);
    const links = await openCaseLinks("order_payment", shown.map((o) => o.number));
    return {
      kind,
      page,
      hasMore: docs.length > pageSize,
      items: shown.map((o) => ({
        orderNumber: o.number,
        issue: sanitizeIssue(o.reviewIssue),
        category: issueCategory(o.reviewIssue),
        paymentStatus: o.paymentStatus,
        outcome: orderOutcome(o.paymentStatus),
        fulfillmentStatus: o.fulfillmentStatus,
        totalKobo: o.totalKobo,
        paidKobo: recorded(o.paidKobo ?? 0),
        updatedAt: o.updatedAt.toISOString(),
        openCase: links.get(o.number) ?? null,
      })),
    };
  }
  if (kind === "bookings") {
    // no contact details, addresses, notes or payment references
    const docs = await bookings
      .find(FLAGGED_BOOKING, {
        projection: {
          reference: 1,
          status: 1,
          paymentStatus: 1,
          reviewIssue: 1,
          amountKobo: 1,
          paidKobo: 1,
          refundedKobo: 1,
          paidAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(pageSize + 1)
      .toArray();
    const shown = docs.slice(0, pageSize);
    const [links, refundList] = await Promise.all([
      openCaseLinks("service_booking", shown.map((b) => b.reference)),
      shown.length
        ? refunds
            .find({ bookingId: { $in: shown.map((b) => b._id) } }, { projection: { bookingId: 1, status: 1, createdAt: 1 } })
            .sort({ createdAt: 1 })
            .toArray()
        : Promise.resolve([]),
    ]);
    // the latest refund attempt per booking
    const refundStatus = new Map(refundList.map((r) => [r.bookingId.toHexString(), r.status as string]));
    return {
      kind,
      page,
      hasMore: docs.length > pageSize,
      items: shown.map((b) => ({
        reference: b.reference,
        status: b.status,
        paymentStatus: b.paymentStatus,
        outcome: bookingOutcome(b.paymentStatus),
        category: issueCategory(b.reviewIssue),
        issue: sanitizeIssue(b.reviewIssue),
        expectedKobo: b.amountKobo ?? 0,
        paidKobo: recorded(b.paidKobo ?? 0),
        refundedKobo: b.refundedKobo ?? 0,
        refundStatus: refundStatus.get(b._id.toHexString()) ?? null,
        paidAt: b.paidAt?.toISOString() ?? null,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
        openCase: links.get(b.reference) ?? null,
      })),
    };
  }
  if (kind === "payouts") {
    // only these fields are read: never recipientCode, transfer codes or provider details
    const docs = await payouts
      .find(FLAGGED_PAYOUT, {
        projection: {
          reference: 1,
          issue: 1,
          status: 1,
          providerStatus: 1,
          amountKobo: 1,
          bankName: 1,
          accountNumberLast4: 1,
          failureReason: 1,
          updatedAt: 1,
        },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(pageSize + 1)
      .toArray();
    const shown = docs.slice(0, pageSize);
    const links = await openCaseLinks("payout", shown.map((p) => p.reference));
    return {
      kind,
      page,
      hasMore: docs.length > pageSize,
      items: shown.map((p) => ({
        reference: p.reference,
        issue: sanitizeIssue(p.issue),
        category: issueCategory(p.issue),
        status: p.status,
        outcome: payoutOutcome(p.status, p.providerStatus ?? null),
        amountKobo: p.amountKobo,
        bankName: p.bankName,
        accountNumberLast4: String(p.accountNumberLast4 ?? "").slice(-4),
        failureReason: p.failureReason ? sanitizeIssue(p.failureReason, 120) : null,
        updatedAt: p.updatedAt.toISOString(),
        openCase: links.get(p.reference) ?? null,
      })),
    };
  }
  const docs = await deliveries
    .find(FAILED_DELIVERY, {
      projection: { notificationId: 1, channel: 1, state: 1, attempts: 1, lastFailure: 1, updatedAt: 1 },
    })
    .sort({ updatedAt: -1, _id: -1 })
    .skip(skip)
    .limit(pageSize + 1)
    .toArray();
  const shown = docs.slice(0, pageSize);
  const [types, links] = await Promise.all([
    notifications
      .find({ _id: { $in: shown.map((d) => d.notificationId) } }, { projection: { type: 1 } })
      .toArray()
      .then((list) => new Map(list.map((n) => [n._id.toHexString(), n.type as string]))),
    openCaseLinks("notification_delivery", shown.map((d) => d._id.toHexString())),
  ]);
  return {
    kind,
    page,
    hasMore: docs.length > pageSize,
    items: shown.map((d) => ({
      id: d._id.toHexString(),
      channel: d.channel,
      state: d.state as "failed" | "exhausted",
      attempts: d.attempts,
      lastFailure: d.lastFailure ? clip(d.lastFailure, 80) : null,
      notificationType: types.get(d.notificationId.toHexString()) ?? null,
      updatedAt: d.updatedAt.toISOString(),
      openCase: links.get(d._id.toHexString()) ?? null,
    })),
  };
}
