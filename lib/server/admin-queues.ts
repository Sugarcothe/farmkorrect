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
import { auditFor, listAudit } from "./admin-audit";
import { countPendingCredentials } from "./admin-credentials";
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
    deliveries: db.collection<NotificationDeliveryDoc>(COLLECTIONS.notificationDeliveries),
    notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
    fulfillments: db.collection<FulfillmentDoc>(COLLECTIONS.fulfillments),
  };
}

const OPEN_ISSUE: Filter<OrderDoc> = { "issue.reportedAt": { $type: "date" }, "issue.closedAt": null };
const CLOSED_ISSUE: Filter<OrderDoc> = { "issue.reportedAt": { $type: "date" }, "issue.closedAt": { $type: "date" } };
const FLAGGED_ORDER: Filter<OrderDoc> = { reviewIssue: { $type: "string" } };
const FLAGGED_PAYOUT: Filter<PayoutDoc> = { issue: { $type: "string" } };
const FAILED_DELIVERY: Filter<NotificationDeliveryDoc> = { state: { $in: ["failed", "exhausted"] } };

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function getAdminSummary(): Promise<AdminSummary> {
  const { orders, payouts, deliveries } = await collections();
  const [pendingCredentials, openIssues, reviewsToModerate, flaggedOrders, flaggedPayouts, failedDeliveries, recent] =
    await Promise.all([
      countPendingCredentials(),
      orders.countDocuments(OPEN_ISSUE),
      countPendingReviews(),
      orders.countDocuments(FLAGGED_ORDER),
      payouts.countDocuments(FLAGGED_PAYOUT),
      deliveries.countDocuments(FAILED_DELIVERY),
      listAudit({ action: null, targetType: null, targetId: null, actorUserId: null }, 1, 5),
    ]);
  return {
    pendingCredentials,
    openIssues,
    reviewsToModerate,
    flaggedOrders,
    flaggedPayouts,
    failedDeliveries,
    recentActions: recent.entries,
  };
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

export async function listExceptions(kind: ExceptionKind, page: number, pageSize = ADMIN_PAGE_SIZE): Promise<ExceptionPage> {
  const { orders, payouts, deliveries, notifications } = await collections();
  const skip = (page - 1) * pageSize;
  if (kind === "orders") {
    const docs = await orders
      .find(FLAGGED_ORDER, {
        projection: { number: 1, reviewIssue: 1, paymentStatus: 1, fulfillmentStatus: 1, totalKobo: 1, updatedAt: 1 },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(pageSize + 1)
      .toArray();
    return {
      kind,
      page,
      hasMore: docs.length > pageSize,
      items: docs.slice(0, pageSize).map((o) => ({
        orderNumber: o.number,
        issue: clip(o.reviewIssue ?? ""),
        paymentStatus: o.paymentStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        totalKobo: o.totalKobo,
        updatedAt: o.updatedAt.toISOString(),
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
    return {
      kind,
      page,
      hasMore: docs.length > pageSize,
      items: docs.slice(0, pageSize).map((p) => ({
        reference: p.reference,
        issue: clip(p.issue ?? ""),
        status: p.status,
        amountKobo: p.amountKobo,
        bankName: p.bankName,
        accountNumberLast4: String(p.accountNumberLast4 ?? "").slice(-4),
        failureReason: p.failureReason,
        updatedAt: p.updatedAt.toISOString(),
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
  const types = new Map(
    (
      await notifications
        .find({ _id: { $in: shown.map((d) => d.notificationId) } }, { projection: { type: 1 } })
        .toArray()
    ).map((n) => [n._id.toHexString(), n.type as string]),
  );
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
    })),
  };
}

