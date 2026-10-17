import "server-only";
import { createHash, randomInt } from "node:crypto";
import { MongoServerError, ObjectId } from "mongodb";
import {
  ORDER_LIMITS,
  type FulfillmentAction,
  type FulfillmentMethod,
  type OrderActor,
  type OrderRequest,
} from "@/lib/orders/types";
import {
  isFulfillmentMethod,
  validateDeliveryNote,
  validateIssueNote,
  validateRefundReason,
} from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";
import { formatKobo, isKobo } from "@/lib/wallet/money";
import { CURRENCY, SETTLEMENT_DELAY_MS } from "@/lib/wallet/types";
import { getDb } from "./db";
import { HttpError } from "./http";
import { MAX_PAGE_SIZE } from "./ledger";
import { COLLECTIONS, type OrderDoc, type OrderItemDoc, type ProductDoc, type UserDoc } from "./models";
import { syncOrderLedger } from "./order-ledger";
import { closeAttempts, settleActiveAttempt } from "./order-payments";
import { claimOrderRefund, continueRefund } from "./order-refunds";
import {
  bestEffort,
  historyItem,
  notifyOrder,
  inTransaction,
  issueWindowEnd,
  ORDER_NOT_FOUND,
  orderCollections,
  refundableKobo,
  releaseStock,
  reservationEnd,
} from "./order-store";
import { fulfillmentOf, parseObjectId, SELLER_ROLE } from "./products";

// Placing orders and the buyer's and seller's actions on them. The buyer and
// seller always come from the session; prices, the seller, stock and totals
// from the database. Each order has exactly one seller: a cart mixing
// sellers is refused, so every payment maps to one seller's earning.

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** unpaid orders a buyer can have at once (each one holds stock) */
export const MAX_UNPAID_ORDERS = 5;
const NUMBER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CANT_NOW = "This order has changed. Reload the page to see where it is now.";

function newOrderNumber(): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += NUMBER_ALPHABET[randomInt(NUMBER_ALPHABET.length)];
  return `FKO-${suffix}`;
}

// --- placing an order ----------------------------------------------------------------

type ParsedItem = { productId: ObjectId; quantity: number };
export type ParsedOrderRequest = Omit<OrderRequest, "items"> & { items: ParsedItem[] };

export function parseOrderRequest(body: Record<string, unknown>): ParsedOrderRequest {
  const fieldErrors: Record<string, string> = {};
  // prices, totals, sellers and statuses are never accepted
  for (const key of Object.keys(body))
    if (!["items", "fulfillmentMethod", "deliveryNote", "idempotencyKey", "expectedTotalKobo"].includes(key))
      fieldErrors[key] = "This field can't be set.";

  const items: ParsedItem[] = [];
  if (!Array.isArray(body.items) || body.items.length === 0) fieldErrors.items = "Add at least one product.";
  else if (body.items.length > ORDER_LIMITS.items) fieldErrors.items = `An order can have up to ${ORDER_LIMITS.items} products.`;
  else {
    const seen = new Set<string>();
    for (const raw of body.items) {
      const item = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const productId = parseObjectId(item.productId);
      const { quantity } = item;
      if (!productId || Object.keys(item).some((k) => k !== "productId" && k !== "quantity")) {
        fieldErrors.items = "One of the products isn't valid. Reload the page and try again.";
        break;
      }
      if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > ORDER_LIMITS.quantity) {
        fieldErrors.quantity = `Enter a quantity from 1 to ${ORDER_LIMITS.quantity}.`;
        break;
      }
      if (seen.has(productId.toHexString())) {
        fieldErrors.items = "Each product can only be listed once.";
        break;
      }
      seen.add(productId.toHexString());
      items.push({ productId, quantity });
    }
  }

  const { fulfillmentMethod } = body;
  if (!isFulfillmentMethod(fulfillmentMethod)) fieldErrors.fulfillmentMethod = "Choose pickup or delivery.";
  const deliveryNote = typeof body.deliveryNote === "string" ? cleanText(body.deliveryNote, true) : "";
  const noteError = validateDeliveryNote(deliveryNote);
  if (noteError) fieldErrors.deliveryNote = noteError;
  const { idempotencyKey, expectedTotalKobo } = body;
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey))
    fieldErrors.idempotencyKey = "Reload the page and try again.";
  if (expectedTotalKobo !== undefined && !isKobo(expectedTotalKobo))
    fieldErrors.expectedTotalKobo = "Reload the page and try again.";
  if (Object.keys(fieldErrors).length)
    throw new HttpError(400, "Some details aren't valid. Check the highlighted fields.", fieldErrors);
  return {
    items,
    fulfillmentMethod: fulfillmentMethod as FulfillmentMethod,
    deliveryNote,
    idempotencyKey: (idempotencyKey as string).toLowerCase(),
    ...(expectedTotalKobo !== undefined ? { expectedTotalKobo: expectedTotalKobo as number } : {}),
  };
}

function requestHash(input: ParsedOrderRequest): string {
  const items = input.items.map((i) => `${i.productId.toHexString()}x${i.quantity}`).join(",");
  return createHash("sha256")
    .update(`${items}\u0000${input.deliveryNote}\u0000${input.fulfillmentMethod}`)
    .digest("hex");
}

export const FULFILLMENT_CHANGED =
  "The seller changed their pickup or delivery options while you were ordering. Reload the page and choose again.";

type FulfillmentDetail = NonNullable<OrderDoc["fulfillment"]>["details"][number];

/** What the buyer is relying on for this product and method, as it is now. */
function fulfillmentDetail(product: ProductDoc, method: FulfillmentMethod): FulfillmentDetail {
  const options = fulfillmentOf(product);
  return method === "pickup"
    ? { productId: product._id, name: product.name, areas: "", timing: "", instructions: options.pickup.instructions }
    : {
        productId: product._id,
        name: product.name,
        areas: options.delivery.areas,
        timing: options.delivery.timing,
        instructions: options.delivery.instructions,
      };
}

/**
 * Matches the product only while the method and its details are still
 * exactly what the order records, so an edit between reading the listing and
 * reserving its stock is caught. Listings without options are pickup only.
 */
function sameFulfillmentFilter(product: ProductDoc, method: FulfillmentMethod): Record<string, unknown> {
  const f = product.fulfillment;
  if (!f) return { fulfillment: { $exists: false } };
  return method === "pickup"
    ? { "fulfillment.pickup.enabled": true, "fulfillment.pickup.instructions": f.pickup.instructions }
    : {
        "fulfillment.delivery.enabled": true,
        "fulfillment.delivery.areas": f.delivery.areas,
        "fulfillment.delivery.timing": f.delivery.timing,
        "fulfillment.delivery.instructions": f.delivery.instructions,
      };
}

function sameRequest(existing: OrderDoc, hash: string): OrderDoc {
  if (existing.requestHash !== hash)
    throw new HttpError(409, "This order was already placed with different details. Reload the page and try again.");
  return existing;
}

/**
 * Places an order and reserves its stock. Resubmitting the same idempotency
 * key returns the same order. Stock is taken with conditional updates in the
 * same transaction as the order is created, so two buyers can never be sold
 * the same unit.
 */
export async function createOrder(buyer: UserDoc, input: ParsedOrderRequest): Promise<{ order: OrderDoc; created: boolean }> {
  const { orders, products } = await orderCollections();
  const hash = requestHash(input);
  const earlier = await orders.findOne({ buyerUserId: buyer._id, idempotencyKey: input.idempotencyKey });
  if (earlier) return { order: sameRequest(earlier, hash), created: false };

  const unpaid = await orders.countDocuments({
    buyerUserId: buyer._id,
    paymentStatus: { $in: ["pending", "failed"] },
    fulfillmentStatus: "pending",
  });
  if (unpaid >= MAX_UNPAID_ORDERS)
    throw new HttpError(409, "You have several unpaid orders. Pay for or cancel one before placing another.");

  const docs = await products
    .find({ _id: { $in: input.items.map((i) => i.productId) }, active: true, archivedAt: null })
    .toArray();
  const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
  const items: OrderItemDoc[] = [];
  const details: FulfillmentDetail[] = [];
  const reserveFilters: Array<Record<string, unknown>> = [];
  for (const { productId, quantity } of input.items) {
    const product = byId.get(productId.toHexString());
    if (!product) throw new HttpError(409, "A product in your order is no longer available. Reload and try again.");
    if (product.sellerUserId.equals(buyer._id)) throw new HttpError(400, "You can't order your own product.");
    if (!product.sellerUserId.equals(docs[0].sellerUserId))
      throw new HttpError(400, "An order can only contain products from one seller. Place a separate order for each.");
    if (product.stockQuantity < quantity)
      throw new HttpError(
        409,
        product.stockQuantity > 0 ? `Only ${product.stockQuantity} left of ${product.name}.` : `${product.name} is sold out.`,
        { quantity: product.stockQuantity > 0 ? `Only ${product.stockQuantity} left.` : "Sold out." },
      );
    // checked against the listing as it is now, never what the page showed
    if (!fulfillmentOf(product)[input.fulfillmentMethod].enabled) {
      const message = `${product.name} isn't available for ${input.fulfillmentMethod} any more. ${
        input.items.length > 1 ? "Choose an option every product offers." : "Choose another option."
      }`;
      throw new HttpError(409, message, { fulfillmentMethod: message });
    }
    details.push(fulfillmentDetail(product, input.fulfillmentMethod));
    reserveFilters.push(sameFulfillmentFilter(product, input.fulfillmentMethod));
    items.push({
      productId,
      name: product.name,
      unit: product.unit,
      unitPriceKobo: product.priceKobo,
      quantity,
      lineTotalKobo: product.priceKobo * quantity,
    });
  }
  const subtotalKobo = items.reduce((sum, item) => sum + item.lineTotalKobo, 0);
  if (!isKobo(subtotalKobo)) throw new HttpError(400, "This order is larger than we can take. Reduce the quantity.");
  if (input.expectedTotalKobo !== undefined && input.expectedTotalKobo !== subtotalKobo)
    throw new HttpError(
      409,
      `The price changed since you opened this page. The total is now ${formatKobo(subtotalKobo)}. Check it and place the order again.`,
    );

  const sellerUserId = docs[0].sellerUserId;
  const seller = await (await getDb())
    .collection<UserDoc>(COLLECTIONS.users)
    .findOne({ _id: sellerUserId, status: "active", role: SELLER_ROLE });
  if (!seller) throw new HttpError(409, "This seller isn't taking orders right now.");

  const place = async (): Promise<OrderDoc> =>
    inTransaction(async (session) => {
      const now = new Date();
      for (const [index, item] of items.entries()) {
        const live = {
          _id: item.productId,
          sellerUserId,
          active: true,
          archivedAt: null,
          priceKobo: item.unitPriceKobo,
          stockQuantity: { $gte: item.quantity },
        };
        const taken = await products.updateOne(
          { ...live, ...reserveFilters[index] },
          { $inc: { stockQuantity: -item.quantity } },
          { session },
        );
        if (taken.modifiedCount === 1) continue;
        // only the pickup or delivery details changed: say so
        if (await products.countDocuments(live, { session, limit: 1 }))
          throw new HttpError(409, FULFILLMENT_CHANGED, { fulfillmentMethod: FULFILLMENT_CHANGED });
        throw new HttpError(409, `${item.name} changed or sold out while you were ordering. Reload and try again.`);
      }
      const order: OrderDoc = {
        _id: new ObjectId(),
        number: newOrderNumber(),
        buyerUserId: buyer._id,
        sellerUserId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        buyerName: buyer.fullName,
        sellerName: seller.fullName,
        items,
        subtotalKobo,
        // no delivery fee or tax is charged: the seller arranges delivery
        totalKobo: subtotalKobo,
        currency: CURRENCY,
        deliveryNote: input.deliveryNote,
        // a record of what was agreed; it adds nothing to the total
        fulfillment: { method: input.fulfillmentMethod, details },
        paymentStatus: "pending",
        fulfillmentStatus: "pending",
        paymentReference: null,
        paidKobo: 0,
        refundedKobo: 0,
        refundInFlight: null,
        refundPendingKobo: 0,
        inventory: { reservedAt: now, expiresAt: reservationEnd(now), releasedAt: null },
        paidAt: null,
        processingAt: null,
        shippedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        issue: null,
        settlement: null,
        ledgerSyncAt: null,
        reviewIssue: null,
        history: [historyItem("created", "buyer", buyer._id, now)],
        notifySyncAt: now,
        notifiedThrough: 0,
        createdAt: now,
        updatedAt: now,
      };
      await orders.insertOne(order, { session });
      return order;
    });

  for (let attempt = 0; ; attempt++) {
    try {
      const order = await place();
      await notifyOrder(order._id);
      return { order, created: true };
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
      // the same submission committed first, in another request
      const existing = await orders.findOne({ buyerUserId: buyer._id, idempotencyKey: input.idempotencyKey });
      if (existing) return { order: sameRequest(existing, hash), created: false };
      // otherwise the random order number was taken: try another
      if (attempt >= 2) throw error;
    }
  }
}

// --- reading -----------------------------------------------------------------------------

export type Viewer = "buyer" | "seller";

const partyFilter = (viewer: Viewer, userId: ObjectId) =>
  viewer === "buyer" ? { buyerUserId: userId } : { sellerUserId: userId };

/** The user's order with this id, seen as `viewer`; null otherwise (including someone else's). */
export async function findOrderFor(userId: ObjectId, id: string, viewer: Viewer): Promise<OrderDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  return (await orderCollections()).orders.findOne({ _id, ...partyFilter(viewer, userId) });
}

export async function requireOrder(userId: ObjectId, id: string, viewer: Viewer): Promise<OrderDoc> {
  const order = await findOrderFor(userId, id, viewer);
  if (!order) throw new HttpError(404, ORDER_NOT_FOUND);
  return order;
}

export async function listOrders(
  userId: ObjectId,
  viewer: Viewer,
  options: { page: number; pageSize: number },
): Promise<{ orders: OrderDoc[]; hasMore: boolean }> {
  const pageSize = Math.min(Math.max(1, options.pageSize), MAX_PAGE_SIZE);
  const page = Math.max(1, options.page);
  const { orders } = await orderCollections();
  const docs = await orders
    .find(partyFilter(viewer, userId))
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  return { orders: docs.slice(0, pageSize), hasMore: docs.length > pageSize };
}

async function reload(order: OrderDoc): Promise<OrderDoc> {
  const fresh = await (await orderCollections()).orders.findOne({ _id: order._id });
  if (!fresh) throw new HttpError(404, ORDER_NOT_FOUND);
  return fresh;
}

// --- cancelling ------------------------------------------------------------------------------

export type Actor = { by: OrderActor; userId: ObjectId | null };

const CANCELLABLE: Record<OrderActor, OrderDoc["fulfillmentStatus"][]> = {
  buyer: ["pending"],
  seller: ["pending", "processing"],
  system: ["pending"],
};

/** Cancels an unpaid order. False if it was paid (or changed) meanwhile. */
async function cancelUnpaid(order: OrderDoc, actor: Actor, reason: string, expired: boolean): Promise<boolean> {
  const { orders } = await orderCollections();
  const now = new Date();
  const updated = await orders.updateOne(
    {
      _id: order._id,
      paymentStatus: { $in: ["pending", "failed"] },
      fulfillmentStatus: "pending",
      ...(expired ? { "inventory.expiresAt": { $lte: now } } : {}),
    },
    {
      $set: {
        paymentStatus: "cancelled",
        fulfillmentStatus: "cancelled",
        cancelledAt: now,
        cancelledBy: actor.by,
        cancelReason: reason,
        notifySyncAt: now,
        updatedAt: now,
      },
      $push: { history: historyItem(expired ? "expired" : "cancelled", actor.by, actor.userId, now) },
    },
  );
  if (updated.modifiedCount !== 1) return false;
  await notifyOrder(order._id);
  await bestEffort("closing payments", () => closeAttempts(order._id));
  await bestEffort("releasing stock", () => releaseStock(order._id, "system"));
  return true;
}

/** Cancels a paid order before delivery and returns the rest of the payment. */
async function cancelPaid(order: OrderDoc, actor: Actor, reason: string): Promise<boolean> {
  const { orders } = await orderCollections();
  const amountKobo = order.paidKobo - order.refundedKobo;
  const now = new Date();
  const cancelled = {
    fulfillmentStatus: "cancelled" as const,
    cancelledAt: now,
    cancelledBy: actor.by,
    cancelReason: reason,
  };
  const refund = await inTransaction(async (session) => {
    const updated = await orders.findOneAndUpdate(
      {
        _id: order._id,
        paymentStatus: { $in: ["paid", "partially_refunded"] },
        fulfillmentStatus: { $in: CANCELLABLE[actor.by] },
        refundInFlight: null,
      },
      {
        $set: { ...cancelled, notifySyncAt: now, updatedAt: now },
        $push: { history: historyItem("cancelled", actor.by, actor.userId, now) },
      },
      { session, returnDocument: "after" },
    );
    if (!updated) return false;
    if (amountKobo <= 0) return null;
    const claimed = await claimOrderRefund(
      updated,
      { amountKobo, reason: reason ? `Order cancelled: ${reason}` : "Order cancelled", by: actor.by, userId: actor.userId, idempotencyKey: null },
      session,
    );
    // can't happen inside this transaction; abort rather than cancel without a refund
    if (!claimed) throw new Error("Refund claim failed");
    return claimed;
  });
  if (refund === false) return false;
  await notifyOrder(order._id);
  await bestEffort("releasing stock", () => releaseStock(order._id, "system"));
  if (refund) await bestEffort("refund", () => continueRefund(refund._id));
  else await bestEffort("ledger sync", () => syncOrderLedger(order._id));
  return true;
}

/**
 * Cancels an order on behalf of the buyer (before the seller accepts it),
 * the seller (before it's shipped) or the system (an unpaid order that
 * expired). An unpaid order's open payment is checked with Paystack first:
 * if it was paid after all, it's cancelled as a paid order and refunded.
 */
export async function cancelOrder(order: OrderDoc, actor: Actor, reason: string, expired = false): Promise<OrderDoc> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!CANCELLABLE[actor.by].includes(order.fulfillmentStatus) || order.paymentStatus === "cancelled")
      throw new HttpError(409, actor.by === "buyer" && order.fulfillmentStatus !== "cancelled"
        ? "The seller has already started on this order, so it can't be cancelled here. Contact the seller."
        : CANT_NOW);
    if (order.refundInFlight) throw new HttpError(409, "A refund is being processed for this order. Try again shortly.");

    if (order.paymentStatus === "pending" || order.paymentStatus === "failed") {
      const payment = await settleActiveAttempt(order._id);
      if (payment === "unknown")
        throw new HttpError(503, "We couldn't confirm this order's payment with our provider. Please try again in a minute.");
      if (payment === "clear" && (await cancelUnpaid(order, actor, reason, expired))) return reload(order);
    } else if (!expired && (await cancelPaid(order, actor, reason))) {
      return reload(order);
    }
    order = await reload(order);
    if (expired && order.paymentStatus !== "pending" && order.paymentStatus !== "failed") return order;
  }
  throw new HttpError(409, CANT_NOW);
}

export function parseReason(body: Record<string, unknown>, required: boolean): string {
  const reason = typeof body.reason === "string" ? cleanText(body.reason, true) : "";
  if (!reason && !required) return "";
  const error = validateRefundReason(reason);
  if (error) throw new HttpError(400, "Please correct the highlighted fields.", { reason: error });
  return reason;
}

// --- the seller's fulfilment ------------------------------------------------------------------

const FULFILMENT: Record<
  FulfillmentAction,
  { from: OrderDoc["fulfillmentStatus"][]; to: "processing" | "in_transit" | "delivered"; at: "processingAt" | "shippedAt" | "deliveredAt" }
> = {
  accept: { from: ["pending"], to: "processing", at: "processingAt" },
  ship: { from: ["processing"], to: "in_transit", at: "shippedAt" },
  deliver: { from: ["processing", "in_transit"], to: "delivered", at: "deliveredAt" },
};

export function isFulfillmentAction(value: unknown): value is FulfillmentAction {
  return typeof value === "string" && Object.hasOwn(FULFILMENT, value);
}

/**
 * Moves a paid order along. The time of each step is the server's: the
 * delivery time, which starts the 24-hour window, can't be chosen by anyone.
 */
export async function fulfilOrder(order: OrderDoc, sellerUserId: ObjectId, action: FulfillmentAction): Promise<OrderDoc> {
  const step = FULFILMENT[action];
  const { orders } = await orderCollections();
  const now = new Date();
  const updated = await orders.findOneAndUpdate(
    {
      _id: order._id,
      sellerUserId,
      paymentStatus: "paid",
      fulfillmentStatus: { $in: step.from },
      refundInFlight: null,
    },
    {
      $set: {
        fulfillmentStatus: step.to,
        [step.at]: now,
        ...(action === "deliver" ? { ledgerSyncAt: now } : {}),
        notifySyncAt: now,
        updatedAt: now,
      },
      $push: { history: historyItem(step.to, "seller", sellerUserId, now) },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    if (order.paymentStatus !== "paid") throw new HttpError(409, "This order isn't paid yet, so it can't be fulfilled.");
    throw new HttpError(409, CANT_NOW);
  }
  if (action === "deliver") await bestEffort("ledger sync", () => syncOrderLedger(order._id));
  await notifyOrder(order._id);
  return reload(updated);
}

// --- refunds after delivery (or after a failed cancellation refund) ------------------------------

export function parseRefundRequest(body: Record<string, unknown>) {
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(body))
    if (!["amountKobo", "reason", "idempotencyKey"].includes(key)) fieldErrors[key] = "This field can't be set.";
  const { amountKobo, idempotencyKey } = body;
  if (!isKobo(amountKobo) || amountKobo === 0) fieldErrors.amountKobo = "Enter an amount in naira, like 1500.";
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey))
    fieldErrors.idempotencyKey = "Reload the page and try again.";
  const reason = typeof body.reason === "string" ? cleanText(body.reason, true) : "";
  const reasonError = validateRefundReason(reason);
  if (reasonError) fieldErrors.reason = reasonError;
  if (Object.keys(fieldErrors).length)
    throw new HttpError(400, "Some details aren't valid. Check the highlighted fields.", fieldErrors);
  return { amountKobo: amountKobo as number, reason, idempotencyKey: (idempotencyKey as string).toLowerCase() };
}

/**
 * A refund the seller gives the buyer, in part or in full. Submitting the
 * same idempotency key again returns the same refund.
 */
export async function refundOrder(
  order: OrderDoc,
  sellerUserId: ObjectId,
  input: { amountKobo: number; reason: string; idempotencyKey: string },
): Promise<OrderDoc> {
  const { refunds } = await orderCollections();
  const earlier = await refunds.findOne({ orderId: order._id, idempotencyKey: input.idempotencyKey });
  if (earlier) {
    if (earlier.amountKobo !== input.amountKobo)
      throw new HttpError(409, "This refund was already submitted with a different amount. Reload the page and try again.");
    return reload(order);
  }
  if (order.fulfillmentStatus !== "delivered" && order.fulfillmentStatus !== "cancelled")
    throw new HttpError(409, "Cancel the order instead: that refunds the buyer in full.");
  if (order.refundInFlight) throw new HttpError(409, "A refund is already being processed for this order.");
  const refundable = refundableKobo(order);
  if (input.amountKobo > refundable) {
    const message = refundable > 0 ? `You can refund up to ${formatKobo(refundable)}.` : "Nothing is left to refund.";
    throw new HttpError(422, message, { amountKobo: message });
  }
  let refund;
  try {
    refund = await inTransaction((session) =>
      claimOrderRefund(order, { ...input, by: "seller", userId: sellerUserId }, session),
    );
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return reload(order);
    throw error;
  }
  if (!refund) throw new HttpError(409, CANT_NOW);
  await notifyOrder(order._id);
  await bestEffort("refund", () => continueRefund(refund._id));
  return reload(order);
}

// --- the buyer's issues ------------------------------------------------------------------------------

export function parseIssue(body: Record<string, unknown>): string {
  const note = typeof body.note === "string" ? cleanText(body.note, true) : "";
  const error = validateIssueNote(note);
  if (error || Object.keys(body).some((k) => k !== "note"))
    throw new HttpError(400, "Please correct the highlighted fields.", { note: error ?? "Only a note can be sent." });
  return note;
}

/**
 * The buyer reports a problem within 24 hours of delivery: the seller's
 * earning is put under review until the issue is closed.
 */
export async function reportIssue(order: OrderDoc, buyerUserId: ObjectId, note: string): Promise<OrderDoc> {
  const until = issueWindowEnd(order);
  const now = new Date();
  if (!until || until <= now) throw new HttpError(409, "Problems can be reported up to 24 hours after delivery.");
  const { orders } = await orderCollections();
  const updated = await orders.findOneAndUpdate(
    {
      _id: order._id,
      buyerUserId,
      fulfillmentStatus: "delivered",
      paymentStatus: { $in: ["paid", "partially_refunded"] },
      issue: null,
      deliveredAt: { $gt: new Date(now.getTime() - SETTLEMENT_DELAY_MS) },
    },
    {
      $set: { issue: { reportedAt: now, note, closedAt: null }, ledgerSyncAt: now, notifySyncAt: now, updatedAt: now },
      $push: { history: historyItem("issue_reported", "buyer", buyerUserId, now) },
    },
    { returnDocument: "after" },
  );
  if (!updated) throw new HttpError(409, order.issue ? "You've already reported a problem with this order." : CANT_NOW);
  await bestEffort("ledger sync", () => syncOrderLedger(order._id));
  await notifyOrder(order._id);
  return reload(updated);
}

/** Closes a reported issue (support, through the internal endpoint). */
export async function closeIssue(number: string): Promise<OrderDoc | null> {
  const { orders } = await orderCollections();
  const now = new Date();
  const updated = await orders.findOneAndUpdate(
    { number, issue: { $ne: null }, "issue.closedAt": null },
    {
      $set: { "issue.closedAt": now, ledgerSyncAt: now, notifySyncAt: now, updatedAt: now },
      $push: { history: historyItem("issue_closed", "system", null, now) },
    },
    { returnDocument: "after" },
  );
  if (updated) {
    await bestEffort("ledger sync", () => syncOrderLedger(updated._id));
    await notifyOrder(updated._id);
  }
  return updated;
}
