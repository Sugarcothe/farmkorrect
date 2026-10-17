import "server-only";
import type { ClientSession } from "mongodb";
import { ObjectId } from "mongodb";
import {
  RESERVATION_MS,
  type BuyerAction,
  type Order,
  type OrderActor,
  type OrderEventName,
  type OrderSummary,
  type SellerAction,
} from "@/lib/orders/types";
import { SETTLEMENT_DELAY_MS } from "@/lib/wallet/types";
import { getDb, getMongoClient } from "./db";
import { queueNotifications, syncOrderNotifications } from "./notifications";
import {
  COLLECTIONS,
  type OrderDoc,
  type OrderHistoryDoc,
  type PaymentDoc,
  type ProductDoc,
  type RefundDoc,
} from "./models";

// Shared plumbing for the order modules (order-ledger, order-refunds,
// order-payments, orders, order-jobs): collections, history items, the
// public view of an order and giving reserved stock back.
//
// An order has two independent statuses:
//
//   payment:     pending ──► paid ──► partially_refunded ──► refunded
//                  │  ▲        └───────────────────────────────┘
//                  ▼  │
//                 failed          (pending/failed ──► cancelled when the
//                                  order is cancelled or expires unpaid)
//
//   fulfilment:  pending ──► processing ──► in_transit ──► delivered
//                   └────────────┴──► cancelled
//
// Every change is a conditional update on the current status, made on the
// server from a trusted event (the seller's or buyer's own action, a payment
// verified with Paystack, the job), so each transition happens at most once.

export async function orderCollections() {
  const db = await getDb();
  return {
    orders: db.collection<OrderDoc>(COLLECTIONS.orders),
    payments: db.collection<PaymentDoc>(COLLECTIONS.payments),
    refunds: db.collection<RefundDoc>(COLLECTIONS.refunds),
    products: db.collection<ProductDoc>(COLLECTIONS.products),
  };
}

/** Runs `work` in a MongoDB transaction (retried by the driver on conflicts). */
export async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = await getMongoClient();
  let result!: T;
  await client.withSession((session) =>
    session.withTransaction(async () => {
      result = await work(session);
    }),
  );
  return result;
}

export const historyItem = (
  event: OrderEventName,
  by: OrderActor,
  userId: ObjectId | null = null,
  at = new Date(),
): OrderHistoryDoc => ({ event, at, by, userId });

/**
 * Follow-up work after a change has been committed (ledger sync, stock
 * release, sending a refund). A failure here is logged and left for the
 * job, which retries all of them, instead of failing a request whose main
 * change already happened.
 */
export async function bestEffort(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`[orders] ${label} failed; the order job will retry: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

/**
 * Turns an order's new history items into notifications once the change has
 * committed. Every write that adds a notifying history item also sets
 * notifySyncAt, so if this fails the notification job finishes it.
 */
export const notifyOrder = (orderId: ObjectId) =>
  queueNotifications("order notifications", () => syncOrderNotifications(orderId));

/** Records that an order needs a person to look at it (the first reason is kept). */
export async function flagOrder(orderId: ObjectId, issue: string) {
  console.error(`[orders] order ${orderId.toHexString()} needs review: ${issue}`);
  const { orders } = await orderCollections();
  await orders.updateOne({ _id: orderId, reviewIssue: null }, { $set: { reviewIssue: issue, updatedAt: new Date() } });
}

/** The order's source in the ledger: its public number. */
export const ledgerSource = (order: Pick<OrderDoc, "number">) => ({ sourceType: "order" as const, sourceId: order.number });

export const ORDER_NOT_FOUND = "We couldn't find that order.";

/** How much of the payment can still be refunded. */
export function refundableKobo(order: OrderDoc): number {
  if (order.paymentStatus !== "paid" && order.paymentStatus !== "partially_refunded") return 0;
  return Math.max(0, order.paidKobo - order.refundedKobo - order.refundPendingKobo);
}

const isPaid = (order: OrderDoc) => order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded";

/** Whether the buyer can still start or resume paying. */
export function isPayable(order: OrderDoc, now = new Date()): boolean {
  return (
    (order.paymentStatus === "pending" || order.paymentStatus === "failed") &&
    order.fulfillmentStatus === "pending" &&
    order.inventory.releasedAt === null &&
    order.inventory.expiresAt.getTime() > now.getTime()
  );
}

export function issueWindowEnd(order: OrderDoc): Date | null {
  return order.deliveredAt ? new Date(order.deliveredAt.getTime() + SETTLEMENT_DELAY_MS) : null;
}

export function buyerActions(order: OrderDoc, now = new Date()): BuyerAction[] {
  const actions: BuyerAction[] = [];
  if (isPayable(order, now)) actions.push("pay");
  if (order.fulfillmentStatus === "pending" && !order.refundInFlight && order.paymentStatus !== "cancelled")
    actions.push("cancel");
  const until = issueWindowEnd(order);
  if (order.fulfillmentStatus === "delivered" && isPaid(order) && !order.issue && until && until > now)
    actions.push("report_issue");
  return actions;
}

export function sellerActions(order: OrderDoc): SellerAction[] {
  const actions: SellerAction[] = [];
  const paid = order.paymentStatus === "paid";
  if (paid && order.fulfillmentStatus === "pending") actions.push("accept");
  if (paid && order.fulfillmentStatus === "processing") actions.push("ship");
  if (paid && (order.fulfillmentStatus === "processing" || order.fulfillmentStatus === "in_transit"))
    actions.push("deliver");
  if (
    (order.fulfillmentStatus === "pending" || order.fulfillmentStatus === "processing") &&
    !order.refundInFlight &&
    order.paymentStatus !== "cancelled"
  )
    actions.push("cancel");
  if (
    (order.fulfillmentStatus === "delivered" || order.fulfillmentStatus === "cancelled") &&
    !order.refundInFlight &&
    refundableKobo(order) > 0
  )
    actions.push("refund");
  return actions;
}

export function toOrder(order: OrderDoc, viewer: "buyer" | "seller", now = new Date()): Order {
  const until = issueWindowEnd(order);
  return {
    id: order._id.toHexString(),
    number: order.number,
    viewer,
    sellerName: order.sellerName,
    buyerName: order.buyerName,
    items: order.items.map((item) => ({
      productId: item.productId.toHexString(),
      name: item.name,
      unit: item.unit,
      unitPriceKobo: item.unitPriceKobo,
      quantity: item.quantity,
      lineTotalKobo: item.lineTotalKobo,
    })),
    subtotalKobo: order.subtotalKobo,
    totalKobo: order.totalKobo,
    currency: order.currency,
    deliveryNote: order.deliveryNote,
    fulfillment: order.fulfillment
      ? {
          method: order.fulfillment.method,
          details: order.fulfillment.details.map((d) => ({ ...d, productId: d.productId.toHexString() })),
        }
      : null,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    refundedKobo: order.refundedKobo,
    refundPendingKobo: order.refundPendingKobo,
    refundableKobo: refundableKobo(order),
    payBy: isPayable(order, now) ? order.inventory.expiresAt.toISOString() : null,
    paidAt: order.paidAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    cancelledBy: order.cancelledBy,
    issue: order.issue
      ? { reportedAt: order.issue.reportedAt.toISOString(), note: order.issue.note, open: order.issue.closedAt === null }
      : null,
    reportIssueUntil: viewer === "buyer" && buyerActions(order, now).includes("report_issue") ? until!.toISOString() : null,
    actions: viewer === "buyer" ? buyerActions(order, now) : sellerActions(order),
    history: order.history.map((h) => ({ event: h.event, at: h.at.toISOString(), by: h.by })),
    createdAt: order.createdAt.toISOString(),
  };
}

export function toOrderSummary(order: OrderDoc, viewer: "buyer" | "seller"): OrderSummary {
  return {
    id: order._id.toHexString(),
    number: order.number,
    viewer,
    sellerName: order.sellerName,
    buyerName: order.buyerName,
    totalKobo: order.totalKobo,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    createdAt: order.createdAt.toISOString(),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    firstItem: order.items[0]?.name ?? "",
  };
}

export const reservationEnd = (from: Date) => new Date(from.getTime() + RESERVATION_MS);

/**
 * Gives a cancelled order's stock back, exactly once: the release is
 * recorded on the order in the same transaction that restocks the products.
 * Delivered orders are never restocked.
 */
export async function releaseStock(orderId: ObjectId, by: OrderActor): Promise<boolean> {
  const { orders, products } = await orderCollections();
  return inTransaction(async (session) => {
    const now = new Date();
    const order = await orders.findOneAndUpdate(
      { _id: orderId, fulfillmentStatus: "cancelled", "inventory.releasedAt": null },
      {
        $set: { "inventory.releasedAt": now, updatedAt: now },
        $push: { history: historyItem("stock_released", by, null, now) },
      },
      { session, returnDocument: "after" },
    );
    if (!order) return false;
    for (const item of order.items)
      await products.updateOne({ _id: item.productId }, { $inc: { stockQuantity: item.quantity } }, { session });
    return true;
  });
}
