import "server-only";
import { MongoServerError, ObjectId, type ClientSession } from "mongodb";
import { formatKobo, isKobo } from "@/lib/wallet/money";
import {
  CURRENCY,
  MIN_PAYOUT_KOBO,
  type Payout,
  type PayoutDestination,
  type PayoutFailureReason,
  type PayoutRequest,
} from "@/lib/wallet/types";
import { ConfigError, getTransferConfig } from "./config";
import { getDb } from "./db";
import { HttpError } from "./http";
import { MAX_PAGE_SIZE, spendableKobo, withWallet } from "./ledger";
import { COLLECTIONS, type PayoutDoc, type PayoutHistoryItem } from "./models";
import { findCurrentAccount } from "./payout-accounts";
import {
  initiateTransfer,
  isPaystackConfigured,
  PaystackError,
  transferOutcome,
  verifyTransfer,
  type TransferResult,
} from "./paystack";

// Payouts: a merchant asks for some of their available balance to be sent to
// their verified bank account (never automatically).
//
//   requested ──► processing ──► paid
//                     │
//                     └────────► failed   (the held amount is returned once)
//
// Requesting holds the amount in the ledger, in the same transaction that
// checks the balance and creates the payout, under the user's wallet lock
// (see withWallet). Paystack is only called afterwards, outside any
// transaction, by processPayout. A transfer is sent at most once per payout;
// when its outcome is unknown (timeout, outage) the payout stays
// "processing" with the amount still held, and is settled later from
// Paystack's webhook or by reconcilePayout, which only ever looks the
// transfer up. Every status change is a conditional update, so each one can
// happen once, and its ledger entry has a unique idempotency key.

export const PAYOUTS_OFF =
  "Payouts aren't switched on yet. Your earnings are safe in your wallet and you can withdraw them once payouts open.";
export const NO_PAYOUT_ACCOUNT = "Add and verify a bank account in Profile → Bank Details before requesting a payout.";
const INSUFFICIENT = "That's more than your available balance.";
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PAYOUT_REFERENCE = /^fkp_[0-9a-f]{24}$/;
/** a transfer Paystack still doesn't know about this long after we sent it never happened */
const NOT_FOUND_GRACE_MS = 30 * 60_000;
/** processing payouts are checked with Paystack at most this often */
const RECHECK_AFTER_MS = 2 * 60_000;

async function payouts() {
  return (await getDb()).collection<PayoutDoc>(COLLECTIONS.payouts);
}

const referenceFor = (id: ObjectId) => `fkp_${id.toHexString()}`;

export function toPublicPayout(doc: PayoutDoc): Payout {
  return {
    id: doc._id.toHexString(),
    reference: doc.reference,
    amountKobo: doc.amountKobo,
    currency: doc.currency,
    status: doc.status,
    bankName: doc.bankName,
    accountNumberLast4: doc.accountNumberLast4,
    failureReason: doc.failureReason,
    requestedAt: doc.requestedAt.toISOString(),
    paidAt: doc.paidAt?.toISOString() ?? null,
    failedAt: doc.failedAt?.toISOString() ?? null,
  };
}

/** Whether payouts can be requested and sent; a configuration mistake counts as off (and is logged). */
export function payoutsEnabled(): boolean {
  try {
    return getTransferConfig().enabled;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[payouts] configuration error: ${error.message}`);
    return false;
  }
}

/** The masked account a payout would go to now, or null when there's none ready. */
export async function payoutDestination(userId: ObjectId): Promise<PayoutDestination | null> {
  const account = await findCurrentAccount(userId);
  if (!account || account.status !== "recipient_created" || !account.recipientCode) return null;
  return { bankName: account.bankName, accountNumberLast4: account.accountNumberLast4 };
}

// --- requesting -----------------------------------------------------------------

export function parsePayoutRequest(body: Record<string, unknown>): PayoutRequest {
  const fieldErrors: Record<string, string> = {};
  // balances, statuses, accounts and recipient codes are never accepted
  for (const key of Object.keys(body))
    if (key !== "amountKobo" && key !== "idempotencyKey") fieldErrors[key] = "This field can't be set.";
  const { amountKobo, idempotencyKey } = body;
  if (!isKobo(amountKobo) || amountKobo === 0) fieldErrors.amountKobo = "Enter an amount in naira, like 5000.";
  else if (amountKobo < MIN_PAYOUT_KOBO)
    fieldErrors.amountKobo = `The smallest payout is ${formatKobo(MIN_PAYOUT_KOBO)}.`;
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey))
    fieldErrors.idempotencyKey = "Reload the page and try again.";
  if (Object.keys(fieldErrors).length)
    throw new HttpError(400, "Some details aren't valid. Check the highlighted fields.", fieldErrors);
  return { amountKobo: amountKobo as number, idempotencyKey: (idempotencyKey as string).toLowerCase() };
}

function sameRequest(existing: PayoutDoc, input: PayoutRequest): PayoutDoc {
  if (existing.amountKobo !== input.amountKobo)
    throw new HttpError(409, "This payout was already submitted with a different amount. Reload the page and try again.");
  return existing;
}

const historyItem = (status: PayoutDoc["status"], by: PayoutHistoryItem["by"], at = new Date()): PayoutHistoryItem => ({
  status,
  at,
  by,
});

/**
 * Creates a payout for the signed-in user and holds the amount. Submitting
 * the same idempotency key again returns the same payout instead of a new
 * one. The amount is checked against the balance inside the transaction that
 * holds it, so concurrent requests can't spend the same money twice.
 */
export async function requestPayout(
  userId: ObjectId,
  input: PayoutRequest,
): Promise<{ payout: PayoutDoc; created: boolean }> {
  const collection = await payouts();
  const earlier = await collection.findOne({ userId, idempotencyKey: input.idempotencyKey });
  if (earlier) return { payout: sameRequest(earlier, input), created: false };

  if (!payoutsEnabled()) throw new HttpError(503, PAYOUTS_OFF);

  // loaded on the server: the browser never chooses where the money goes
  const account = await findCurrentAccount(userId);
  if (!account || account.status !== "recipient_created" || !account.recipientCode)
    throw new HttpError(409, NO_PAYOUT_ACCOUNT, { bankAccount: NO_PAYOUT_ACCOUNT });

  try {
    return await withWallet(userId, async (tx) => {
      const duplicate = await collection.findOne({ userId, idempotencyKey: input.idempotencyKey }, { session: tx.session });
      if (duplicate) return { payout: sameRequest(duplicate, input), created: false };

      const spendable = await spendableKobo(userId, tx.session);
      if (input.amountKobo > spendable) {
        const message =
          spendable > 0 ? `${INSUFFICIENT} You can withdraw up to ${formatKobo(spendable)}.` : `${INSUFFICIENT} You have nothing available to withdraw yet.`;
        throw new HttpError(422, message, { amountKobo: message });
      }

      const now = new Date();
      const _id = new ObjectId();
      const doc: PayoutDoc = {
        _id,
        userId,
        idempotencyKey: input.idempotencyKey,
        amountKobo: input.amountKobo,
        currency: CURRENCY,
        status: "requested",
        payoutAccountId: account._id,
        recipientCode: account.recipientCode!,
        bankName: account.bankName,
        accountNumberLast4: account.accountNumberLast4,
        reference: referenceFor(_id),
        transferCode: null,
        providerStatus: null,
        failureReason: null,
        issue: null,
        transferInitiatedAt: null,
        lastCheckedAt: null,
        requestedAt: now,
        processingAt: null,
        paidAt: null,
        failedAt: null,
        history: [historyItem("requested", "user", now)],
        createdAt: now,
        updatedAt: now,
      };
      await collection.insertOne(doc, { session: tx.session });
      await tx.append([
        { type: "payout_hold", amountKobo: doc.amountKobo, idempotencyKey: `payout_hold:${_id.toHexString()}`, payoutId: _id },
      ]);
      return { payout: doc, created: true };
    });
  } catch (error) {
    // the same submission committed first, in another request
    if (error instanceof MongoServerError && error.code === 11000) {
      const existing = await collection.findOne({ userId, idempotencyKey: input.idempotencyKey });
      if (existing) return { payout: sameRequest(existing, input), created: false };
    }
    throw error;
  }
}

// --- status changes ---------------------------------------------------------------

async function flagIssue(payoutId: ObjectId, issue: string, session?: ClientSession) {
  console.error(`[payouts] payout ${payoutId.toHexString()} needs review: ${issue}`);
  await (await payouts()).updateOne(
    { _id: payoutId, issue: null },
    { $set: { issue, updatedAt: new Date() } },
    { session },
  );
}

/** processing → paid, recording that the held amount left the wallet. */
async function markPaid(payout: PayoutDoc, transfer: TransferResult | null, by: PayoutHistoryItem["by"]) {
  const collection = await payouts();
  await withWallet(payout.userId, async (tx) => {
    const now = new Date();
    const updated = await collection.findOneAndUpdate(
      { _id: payout._id, status: "processing" },
      {
        $set: {
          status: "paid",
          paidAt: now,
          providerStatus: transfer?.status ?? "success",
          transferCode: transfer?.transferCode ?? payout.transferCode,
          lastCheckedAt: now,
          updatedAt: now,
        },
        $push: { history: historyItem("paid", by, now) },
      },
      { session: tx.session },
    );
    if (!updated) {
      const current = await collection.findOne({ _id: payout._id }, { session: tx.session });
      // already paid: a repeated event. Anything else contradicts what we recorded.
      if (current && current.status !== "paid") await flagIssue(payout._id, `success reported while ${current.status}`, tx.session);
      return;
    }
    await tx.append([
      { type: "payout_paid", amountKobo: payout.amountKobo, idempotencyKey: `payout_paid:${payout._id.toHexString()}`, payoutId: payout._id },
    ]);
  });
}

/** processing → failed, returning the held amount exactly once. */
async function markFailed(
  payout: PayoutDoc,
  reason: PayoutFailureReason,
  by: PayoutHistoryItem["by"],
  providerStatus: string | null = null,
) {
  const collection = await payouts();
  await withWallet(payout.userId, async (tx) => {
    const now = new Date();
    const updated = await collection.findOneAndUpdate(
      { _id: payout._id, status: "processing" },
      {
        $set: {
          status: "failed",
          failedAt: now,
          failureReason: reason,
          providerStatus: providerStatus ?? payout.providerStatus,
          lastCheckedAt: now,
          updatedAt: now,
        },
        $push: { history: historyItem("failed", by, now) },
      },
      { session: tx.session },
    );
    if (!updated) {
      const current = await collection.findOne({ _id: payout._id }, { session: tx.session });
      // a reversal after the money was sent needs a person: it's not undone automatically
      if (current?.status === "paid") await flagIssue(payout._id, `${providerStatus ?? reason} reported after payment`, tx.session);
      return;
    }
    await tx.append([
      {
        type: "payout_release",
        amountKobo: payout.amountKobo,
        idempotencyKey: `payout_release:${payout._id.toHexString()}`,
        payoutId: payout._id,
      },
    ]);
  });
}

/** Applies what Paystack reported for this payout's transfer. */
async function applyTransfer(payout: PayoutDoc, transfer: TransferResult, by: PayoutHistoryItem["by"]) {
  // only ever act on the transfer we sent, for the amount and account we sent it to
  if (
    transfer.reference !== payout.reference ||
    transfer.amountKobo !== payout.amountKobo ||
    (transfer.recipientCode !== null && transfer.recipientCode !== payout.recipientCode)
  ) {
    await flagIssue(payout._id, "provider details don't match the payout");
    return;
  }
  const outcome = transferOutcome(transfer.status);
  if (outcome === "paid") return markPaid(payout, transfer, by);
  if (outcome === "failed")
    return markFailed(payout, transfer.status === "reversed" ? "provider_reversed" : "provider_failed", by, transfer.status);

  if (transfer.status === "otp")
    console.error("[payouts] a transfer is waiting for an OTP: disable transfer OTP on the Paystack account");
  const now = new Date();
  await (await payouts()).updateOne(
    { _id: payout._id, status: "processing" },
    {
      $set: {
        providerStatus: transfer.status,
        transferCode: transfer.transferCode ?? payout.transferCode,
        lastCheckedAt: now,
        updatedAt: now,
      },
    },
  );
}

async function noteUnknown(payoutId: ObjectId) {
  const now = new Date();
  await (await payouts()).updateOne(
    { _id: payoutId, status: "processing" },
    { $set: { providerStatus: "unknown", lastCheckedAt: now, updatedAt: now } },
  );
}

// --- sending and reconciling ------------------------------------------------------

/** Sends the transfer for a processing payout, unless it was already sent. */
async function sendTransfer(payout: PayoutDoc) {
  const collection = await payouts();

  // the account must still be the one the user requested the payout to
  const account = await findCurrentAccount(payout.userId);
  if (!account || !account._id.equals(payout.payoutAccountId) || account.recipientCode !== payout.recipientCode)
    return markFailed(payout, "account_changed", "processor");

  // marked first: a transfer is never sent twice for the same payout
  const now = new Date();
  const marked = await collection.updateOne(
    { _id: payout._id, status: "processing", transferInitiatedAt: null },
    { $set: { transferInitiatedAt: now, updatedAt: now } },
  );
  if (marked.modifiedCount !== 1) return;

  let transfer: TransferResult;
  try {
    transfer = await initiateTransfer({
      amountKobo: payout.amountKobo,
      recipientCode: payout.recipientCode,
      reference: payout.reference,
      reason: "Farm Korret payout",
    });
  } catch (error) {
    if (!(error instanceof PaystackError)) {
      // e.g. configuration: the outcome is unknown, so it's left for reconciliation
      console.error(`[payouts] sending a transfer failed: ${error instanceof Error ? error.name : "unknown"}`);
      return noteUnknown(payout._id);
    }
    // the key was refused, so the request never reached the transfer step
    if (error.failure === "misconfigured") return markFailed(payout, "transfers_misconfigured", "processor");
    if (error.failure === "unavailable") return noteUnknown(payout._id);
    // refused: make sure Paystack really has no transfer before releasing the amount
    return checkWithProvider({ ...payout, transferInitiatedAt: now }, "processor", 0, "provider_rejected");
  }
  await applyTransfer(payout, transfer, "processor");
}

/**
 * Sends a requested payout to Paystack. Runs after the request has been
 * answered, and from the processing job for any that were missed. Does
 * nothing if payouts are switched off or another run already took it.
 */
export async function processPayout(payoutId: ObjectId): Promise<void> {
  if (!payoutsEnabled()) return;
  const now = new Date();
  const claimed = await (await payouts()).findOneAndUpdate(
    { _id: payoutId, status: "requested" },
    {
      $set: { status: "processing", processingAt: now, updatedAt: now },
      $push: { history: historyItem("processing", "processor", now) },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return;
  await sendTransfer(claimed);
}

async function checkWithProvider(
  payout: PayoutDoc,
  by: PayoutHistoryItem["by"],
  graceMs: number,
  notFoundReason: PayoutFailureReason,
) {
  let transfer: TransferResult | null;
  try {
    transfer = await verifyTransfer(payout.reference);
  } catch (error) {
    if (!(error instanceof PaystackError)) throw error;
    return noteUnknown(payout._id);
  }
  if (transfer) return applyTransfer(payout, transfer, by);
  const sentAt = payout.transferInitiatedAt?.getTime() ?? 0;
  if (Date.now() - sentAt >= graceMs) return markFailed(payout, notFoundReason, by, "not_found");
  await noteUnknown(payout._id);
}

/**
 * Settles a processing payout from Paystack's record of its transfer. Never
 * sends a transfer that was already sent; one that was claimed but never
 * sent (the server stopped in between) is sent now.
 */
export async function reconcilePayout(payoutId: ObjectId): Promise<void> {
  const payout = await (await payouts()).findOne({ _id: payoutId, status: "processing" });
  if (!payout) return;
  if (!payout.transferInitiatedAt) {
    if (payoutsEnabled()) await sendTransfer(payout);
    return;
  }
  await checkWithProvider(payout, "reconciliation", NOT_FOUND_GRACE_MS, "not_found_at_provider");
}

/** One run of the processing job: send what's queued, then check what's unsettled. */
export async function runPayoutJob(limit = 20): Promise<{ sent: number; checked: number }> {
  const collection = await payouts();
  let sent = 0;
  let checked = 0;
  if (payoutsEnabled()) {
    const queued = await collection.find({ status: "requested" }).sort({ updatedAt: 1 }).limit(limit).toArray();
    for (const payout of queued) {
      await processPayout(payout._id);
      sent++;
    }
  }
  if (isPaystackConfigured()) {
    const before = new Date(Date.now() - RECHECK_AFTER_MS);
    const unsettled = await collection
      .find({ status: "processing", updatedAt: { $lt: before } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .toArray();
    for (const payout of unsettled) {
      await reconcilePayout(payout._id);
      checked++;
    }
  }
  return { sent, checked };
}

// --- webhooks --------------------------------------------------------------------

const EVENT_STATUS: Record<string, string> = {
  "transfer.success": "success",
  "transfer.failed": "failed",
  "transfer.reversed": "reversed",
};

export function isTransferEvent(event: string): boolean {
  return Object.hasOwn(EVENT_STATUS, event);
}

/**
 * Applies a verified transfer webhook. Repeats and out-of-order events are
 * safe: each status change happens at most once, and a contradiction (e.g.
 * success after failure) is flagged for review instead of being applied.
 */
export async function handleTransferEvent(event: string, transfer: TransferResult): Promise<"applied" | "ignored"> {
  if (!PAYOUT_REFERENCE.test(transfer.reference)) return "ignored";
  const payout = await (await payouts()).findOne({ reference: transfer.reference });
  if (!payout) return "ignored";
  // the event name and the status inside it must agree
  if (transfer.status !== EVENT_STATUS[event]) {
    await flagIssue(payout._id, `${event} carried status ${transfer.status}`);
    return "ignored";
  }
  await applyTransfer(payout, transfer, "webhook");
  return "applied";
}

// --- reading ---------------------------------------------------------------------

export async function listPayouts(
  userId: ObjectId,
  options: { page: number; pageSize: number },
): Promise<{ payouts: Payout[]; hasMore: boolean }> {
  const pageSize = Math.min(Math.max(1, options.pageSize), MAX_PAGE_SIZE);
  const page = Math.max(1, options.page);
  const docs = await (await payouts())
    .find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  return { payouts: docs.slice(0, pageSize).map(toPublicPayout), hasMore: docs.length > pageSize };
}
