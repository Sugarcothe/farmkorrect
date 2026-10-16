import "server-only";
import { HttpError } from "./http";
import { syncOrderLedger } from "./order-ledger";
import { paymentsEnabled, reconcilePayments } from "./order-payments";
import { reconcileRefunds } from "./order-refunds";
import { bestEffort, orderCollections, releaseStock } from "./order-store";
import { cancelOrder } from "./orders";
import { isPaystackConfigured } from "./paystack";

// The scheduled order job (see app/api/internal/orders/process). Each step
// is safe to repeat and to run alongside requests and webhooks.

/** payments and refunds nobody has checked for this long are looked up */
const RECHECK_AFTER_MS = 2 * 60_000;
/** ledger syncs that didn't finish this long ago are retried */
const LEDGER_RETRY_AFTER_MS = 60_000;

export type OrderJobResult = {
  expired: number;
  stockReleased: number;
  paymentsChecked: number;
  refundsChecked: number;
  ledgerSynced: number;
};

export async function runOrderJob(limit = 20): Promise<OrderJobResult> {
  const { orders } = await orderCollections();
  const now = new Date();
  const result: OrderJobResult = { expired: 0, stockReleased: 0, paymentsChecked: 0, refundsChecked: 0, ledgerSynced: 0 };

  // unpaid orders past their reservation: their open payment is checked
  // first, and they're skipped while Paystack can't be reached
  const overdue = await orders
    .find({ paymentStatus: { $in: ["pending", "failed"] }, "inventory.expiresAt": { $lte: now }, fulfillmentStatus: "pending" })
    .sort({ "inventory.expiresAt": 1 })
    .limit(limit)
    .toArray();
  for (const order of overdue) {
    try {
      const after = await cancelOrder(order, { by: "system", userId: null }, "Not paid in time", true);
      if (after.paymentStatus === "cancelled") result.expired++;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }

  // cancellations whose stock release didn't finish
  const unreleased = await orders
    .find({ fulfillmentStatus: "cancelled", "inventory.releasedAt": null })
    .limit(limit)
    .toArray();
  for (const order of unreleased) if (await releaseStock(order._id, "system")) result.stockReleased++;

  if (isPaystackConfigured()) {
    if (paymentsEnabled()) result.paymentsChecked = await reconcilePayments(limit, RECHECK_AFTER_MS);
    result.refundsChecked = await reconcileRefunds(limit, RECHECK_AFTER_MS);
  }

  // ledger changes that didn't finish, and paid orders waiting for a
  // commission policy (settled as soon as one is configured)
  const stale = await orders
    .find({ ledgerSyncAt: { $lte: new Date(now.getTime() - LEDGER_RETRY_AFTER_MS) } })
    .sort({ ledgerSyncAt: 1 })
    .limit(limit)
    .toArray();
  const unsettled = await orders
    .find({ settlement: null, paidAt: { $type: "date" }, fulfillmentStatus: { $ne: "cancelled" } })
    .sort({ paidAt: 1 })
    .limit(limit)
    .toArray();
  const ids = new Map([...stale, ...unsettled].map((o) => [o._id.toHexString(), o._id]));
  for (const id of ids.values()) {
    await bestEffort("ledger sync", () => syncOrderLedger(id));
    result.ledgerSynced++;
  }
  return result;
}
