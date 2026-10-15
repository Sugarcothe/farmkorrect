import "server-only";
import { MongoServerError, ObjectId, type ClientSession, type Document } from "mongodb";
import { isKobo } from "@/lib/wallet/money";
import {
  CURRENCY,
  SETTLEMENT_DELAY_MS,
  type Direction,
  type Earning,
  type EarningSourceType,
  type EarningStatus,
  type LedgerEntryType,
  type TransactionFilter,
  type WalletSummary,
  type WalletTransaction,
} from "@/lib/wallet/types";
import { getDb, getMongoClient } from "./db";
import {
  COLLECTIONS,
  type FulfillmentDoc,
  type LedgerEntryDoc,
  type LedgerSource,
  type PayoutDoc,
  type WalletAccountDoc,
} from "./models";

// The financial ledger: the single source of truth for every balance.
//
// Entries are append-only. Nothing in the app updates or deletes one, and
// there is no stored balance anywhere: the wallet summary is derived from the
// entries (plus the delivery record of each order or booking, which decides
// when its earnings become available).
//
// Writes for a user happen inside a MongoDB transaction that first
// increments that user's wallet_accounts document. Two concurrent writes for
// the same user (two payout requests, a refund during a payout…) therefore
// conflict on that document; MongoDB aborts one and withTransaction runs it
// again on a fresh snapshot that includes the other's entries. This is what
// makes "check the balance, then hold the funds" safe.
//
// FOUNDATION BOUNDARY: the app doesn't have orders, payments, delivery
// confirmation or refunds yet. recordEarning, recordDelivery, recordRefund and
// the dispute functions below are the server-side entry points those future
// modules must call (from trusted code such as a verified payment webhook),
// and they are deliberately not exposed through any API route. There is no
// platform commission rule either: the fee is whatever the trusted caller
// passes, and nothing here invents a rate.

// --- what each entry type does -------------------------------------------------

/**
 * How each entry type changes each balance (amounts are always positive):
 * - sourceNet: added to (+1) or taken from (-1) the net earnings of its
 *   order/booking, which count as pending, under review or available
 *   depending on that order's delivery and dispute state
 * - available / held / paidOut: applied directly to those balances
 */
export const ENTRY_EFFECTS: Record<
  LedgerEntryType,
  { sourceNet: -1 | 0 | 1; available: -1 | 0 | 1; held: -1 | 0 | 1; paidOut: 0 | 1; direction: Direction }
> = {
  earning: { sourceNet: 1, available: 0, held: 0, paidOut: 0, direction: "credit" },
  platform_fee: { sourceNet: -1, available: 0, held: 0, paidOut: 0, direction: "debit" },
  refund: { sourceNet: -1, available: 0, held: 0, paidOut: 0, direction: "debit" },
  payout_hold: { sourceNet: 0, available: -1, held: 1, paidOut: 0, direction: "debit" },
  payout_release: { sourceNet: 0, available: 1, held: -1, paidOut: 0, direction: "credit" },
  payout_paid: { sourceNet: 0, available: 0, held: -1, paidOut: 1, direction: "none" },
};

const SOURCE_TYPES = ["order", "service_booking"] as const satisfies readonly EarningSourceType[];
const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_REF = /^[A-Za-z0-9_.=:-]{1,100}$/;
/** deliveries reported slightly ahead of our clock are accepted */
const CLOCK_SKEW_MS = 60_000;

/** The input to a ledger function was invalid (a bug in the trusted caller). */
export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

/** The same event was recorded before with different values. Nothing was written. */
export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

async function db() {
  const database = await getDb();
  return {
    entries: database.collection<LedgerEntryDoc>(COLLECTIONS.ledgerEntries),
    fulfillments: database.collection<FulfillmentDoc>(COLLECTIONS.fulfillments),
    wallets: database.collection<WalletAccountDoc>(COLLECTIONS.walletAccounts),
    payouts: database.collection<PayoutDoc>(COLLECTIONS.payouts),
  };
}

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

// --- writing -------------------------------------------------------------------

export type NewEntry = {
  type: LedgerEntryType;
  amountKobo: number;
  idempotencyKey: string;
  source?: LedgerSource | null;
  payoutId?: ObjectId | null;
  paymentReference?: string | null;
  refundId?: string | null;
};

export type WalletTx = {
  session: ClientSession;
  /** appends entries for this user, in order, inside the transaction */
  append(entries: NewEntry[]): Promise<LedgerEntryDoc[]>;
};

/**
 * Runs `work` in a transaction holding the user's wallet lock. Everything it
 * reads with `tx.session` reflects every earlier write for this user, and
 * everything it writes commits together or not at all.
 */
export async function withWallet<T>(userId: ObjectId, work: (tx: WalletTx) => Promise<T>): Promise<T> {
  const { entries, wallets } = await db();
  const now = new Date();
  // created outside the transaction, so two first writes can't race on the insert
  await wallets
    .updateOne({ _id: userId }, { $setOnInsert: { sequence: 0, createdAt: now, updatedAt: now } }, { upsert: true })
    .catch((error: unknown) => {
      if (!isDuplicateKey(error)) throw error;
    });

  const client = await getMongoClient();
  let result!: T;
  await client.withSession((session) =>
    session.withTransaction(async () => {
      // take the lock first, so the snapshot every later read uses is current
      await wallets.updateOne({ _id: userId }, { $set: { updatedAt: new Date() } }, { session });
      const tx: WalletTx = {
        session,
        async append(newEntries) {
          if (newEntries.length === 0) return [];
          for (const entry of newEntries) {
            if (!isKobo(entry.amountKobo) || entry.amountKobo <= 0)
              throw new LedgerValidationError(`Invalid ${entry.type} amount.`);
          }
          const wallet = await wallets.findOneAndUpdate(
            { _id: userId },
            { $inc: { sequence: newEntries.length } },
            { session, returnDocument: "after" },
          );
          if (!wallet) throw new Error("Wallet account missing");
          const first = wallet.sequence - newEntries.length + 1;
          const createdAt = new Date();
          const docs: LedgerEntryDoc[] = newEntries.map((entry, i) => ({
            _id: new ObjectId(),
            userId,
            type: entry.type,
            amountKobo: entry.amountKobo,
            currency: CURRENCY,
            source: entry.source ?? null,
            payoutId: entry.payoutId ?? null,
            paymentReference: entry.paymentReference ?? null,
            refundId: entry.refundId ?? null,
            idempotencyKey: entry.idempotencyKey,
            sequence: first + i,
            createdAt,
          }));
          await entries.insertMany(docs, { session });
          return docs;
        },
      };
      result = await work(tx);
    }),
  );
  return result;
}

/** Runs `fn` again once if it lost a race on a unique index to an identical write. */
async function onceMoreOnDuplicate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return fn();
  }
}

function checkSource(sourceType: unknown, sourceId: unknown): LedgerSource {
  if (!SOURCE_TYPES.includes(sourceType as EarningSourceType)) throw new LedgerValidationError("Unknown source type.");
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) throw new LedgerValidationError("Invalid source id.");
  return { type: sourceType as EarningSourceType, id: sourceId };
}

function checkCurrency(currency: unknown) {
  if (currency !== CURRENCY) throw new LedgerValidationError("Only NGN is supported.");
}

const earningKey = (s: LedgerSource) => `earning:${s.type}:${s.id}`;
const feeKey = (s: LedgerSource) => `platform_fee:${s.type}:${s.id}`;

export type EarningInput = {
  merchantUserId: ObjectId;
  sourceType: EarningSourceType;
  sourceId: string;
  /** the confirmed payment's reference; an earning can't exist without one */
  paymentReference: string;
  grossKobo: number;
  /** the platform's fee for this order, decided by the caller (may be 0) */
  platformFeeKobo: number;
  currency: string;
};

/**
 * Records what a merchant earned from a paid order or booking: the gross
 * amount, and the platform fee as a separate debit. Recording the same
 * source again with the same values returns the original entry; different
 * values are refused. Call it only once the payment is confirmed.
 */
export async function recordEarning(input: EarningInput): Promise<{ entry: LedgerEntryDoc; created: boolean }> {
  const source = checkSource(input.sourceType, input.sourceId);
  checkCurrency(input.currency);
  if (!(input.merchantUserId instanceof ObjectId)) throw new LedgerValidationError("Invalid merchant.");
  if (typeof input.paymentReference !== "string" || !PROVIDER_REF.test(input.paymentReference))
    throw new LedgerValidationError("A confirmed payment reference is required.");
  if (!isKobo(input.grossKobo) || input.grossKobo <= 0) throw new LedgerValidationError("Invalid gross amount.");
  if (!isKobo(input.platformFeeKobo) || input.platformFeeKobo > input.grossKobo)
    throw new LedgerValidationError("Invalid platform fee.");

  return onceMoreOnDuplicate(async () => {
    const { entries } = await db();
    const existing = await entries.findOne({ idempotencyKey: earningKey(source) });
    // another merchant's earning can't be recorded for the same order
    const owner = existing?.userId ?? input.merchantUserId;
    return withWallet(owner, async (tx) => {
      const earning = await entries.findOne({ idempotencyKey: earningKey(source) }, { session: tx.session });
      if (earning) {
        const fee = await entries.findOne({ idempotencyKey: feeKey(source) }, { session: tx.session });
        const same =
          earning.userId.equals(input.merchantUserId) &&
          earning.amountKobo === input.grossKobo &&
          earning.paymentReference === input.paymentReference &&
          (fee?.amountKobo ?? 0) === input.platformFeeKobo;
        if (!same) throw new LedgerConflictError("This earning was already recorded with different values.");
        return { entry: earning, created: false };
      }
      const [entry] = await tx.append([
        {
          type: "earning",
          amountKobo: input.grossKobo,
          idempotencyKey: earningKey(source),
          source,
          paymentReference: input.paymentReference,
        },
        ...(input.platformFeeKobo > 0
          ? [{ type: "platform_fee" as const, amountKobo: input.platformFeeKobo, idempotencyKey: feeKey(source), source }]
          : []),
      ]);
      return { entry, created: true };
    });
  });
}

/** Changes a fulfilment record, under the merchant's wallet lock when there's an earning. */
async function changeFulfillment(
  source: LedgerSource,
  change: (current: FulfillmentDoc | null, session: ClientSession | undefined) => Promise<FulfillmentDoc | null>,
): Promise<FulfillmentDoc | null> {
  return onceMoreOnDuplicate(async () => {
    const { entries } = await db();
    const earning = await entries.findOne({ idempotencyKey: earningKey(source) });
    const { fulfillments } = await db();
    const run = async (session?: ClientSession) =>
      change(await fulfillments.findOne({ sourceType: source.type, sourceId: source.id }, { session }), session);
    // with no earning yet nothing is available to withdraw, so no lock is needed
    return earning ? withWallet(earning.userId, (tx) => run(tx.session)) : run();
  });
}

/**
 * Records when an order or booking was delivered, from a trusted source
 * (never the merchant's own claim from the browser). The first recorded time
 * is kept: later calls don't move it, so the 24-hour window can't be reset
 * or shortened.
 */
export async function recordDelivery(input: {
  sourceType: EarningSourceType;
  sourceId: string;
  deliveredAt: Date;
}): Promise<{ deliveredAt: Date; changed: boolean }> {
  const source = checkSource(input.sourceType, input.sourceId);
  const at = input.deliveredAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new LedgerValidationError("Invalid delivery time.");
  if (at.getTime() > Date.now() + CLOCK_SKEW_MS) throw new LedgerValidationError("Delivery time is in the future.");

  let changed = false;
  const doc = await changeFulfillment(source, async (current, session) => {
    if (current?.deliveredAt) return current;
    const now = new Date();
    const { fulfillments } = await db();
    const updated = await fulfillments.findOneAndUpdate(
      { sourceType: source.type, sourceId: source.id, deliveredAt: null },
      {
        $set: { deliveredAt: at, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), disputedAt: null, createdAt: now },
      },
      { upsert: true, session, returnDocument: "after" },
    );
    changed = true;
    return updated;
  });
  return { deliveredAt: doc!.deliveredAt!, changed };
}

/** Puts an order's earnings on hold (not withdrawable) while a dispute is open. */
export async function openDispute(input: { sourceType: EarningSourceType; sourceId: string }) {
  await setDispute(checkSource(input.sourceType, input.sourceId), true);
}

/** Ends a dispute; any refund it led to must be recorded with recordRefund first. */
export async function closeDispute(input: { sourceType: EarningSourceType; sourceId: string }) {
  await setDispute(checkSource(input.sourceType, input.sourceId), false);
}

async function setDispute(source: LedgerSource, open: boolean) {
  await changeFulfillment(source, async (current, session) => {
    if (open ? current?.disputedAt : !current?.disputedAt) return current;
    const now = new Date();
    const { fulfillments } = await db();
    return fulfillments.findOneAndUpdate(
      { sourceType: source.type, sourceId: source.id },
      {
        $set: { disputedAt: open ? now : null, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), deliveredAt: null, createdAt: now },
      },
      { upsert: true, session, returnDocument: "after" },
    );
  });
}

/**
 * Records a refund to the buyer as a debit on the order's earnings, up to
 * what's left of them after fees and earlier refunds. If the earnings were
 * already paid out, the merchant's available balance goes negative and is
 * recovered from future earnings (shown as "owed").
 */
export async function recordRefund(input: {
  sourceType: EarningSourceType;
  sourceId: string;
  refundId: string;
  amountKobo: number;
  currency: string;
}): Promise<{ entry: LedgerEntryDoc; created: boolean }> {
  const source = checkSource(input.sourceType, input.sourceId);
  checkCurrency(input.currency);
  if (typeof input.refundId !== "string" || !PROVIDER_REF.test(input.refundId))
    throw new LedgerValidationError("Invalid refund id.");
  if (!isKobo(input.amountKobo) || input.amountKobo <= 0) throw new LedgerValidationError("Invalid refund amount.");
  const key = `refund:${input.refundId}`;

  return onceMoreOnDuplicate(async () => {
    const { entries } = await db();
    const earning = await entries.findOne({ idempotencyKey: earningKey(source) });
    if (!earning) throw new LedgerValidationError("There's no earning for this source to refund.");
    return withWallet(earning.userId, async (tx) => {
      const existing = await entries.findOne({ idempotencyKey: key }, { session: tx.session });
      if (existing) {
        const same =
          existing.amountKobo === input.amountKobo &&
          existing.source?.type === source.type &&
          existing.source.id === source.id;
        if (!same) throw new LedgerConflictError("This refund was already recorded with different values.");
        return { entry: existing, created: false };
      }
      const [totals] = await sourceTotals(earning.userId, { sources: [source] }, tx.session);
      const remaining = totals ? totals.netKobo : 0;
      if (input.amountKobo > remaining)
        throw new LedgerValidationError("The refund is more than what's left of this earning.");
      const [entry] = await tx.append([
        { type: "refund", amountKobo: input.amountKobo, idempotencyKey: key, source, refundId: input.refundId },
      ]);
      return { entry, created: true };
    });
  });
}

// --- deriving balances ----------------------------------------------------------

type SourceTotals = {
  source: LedgerSource;
  grossKobo: number;
  feesKobo: number;
  refundedKobo: number;
  netKobo: number;
  createdAt: Date;
};

/** Per-source totals, newest source first. */
async function sourceTotals(
  userId: ObjectId,
  options: { sources?: LedgerSource[]; skip?: number; limit?: number },
  session?: ClientSession,
): Promise<SourceTotals[]> {
  const { entries } = await db();
  const sum = (type: LedgerEntryType) => ({ $sum: { $cond: [{ $eq: ["$type", type] }, "$amountKobo", 0] } });
  const match: Document = { userId, source: { $ne: null } };
  if (options.sources) match.$or = options.sources.map((s) => ({ "source.type": s.type, "source.id": s.id }));
  if (options.sources?.length === 0) return [];
  const pipeline: Document[] = [
    { $match: match },
    {
      $group: {
        _id: { type: "$source.type", id: "$source.id" },
        gross: sum("earning"),
        fees: sum("platform_fee"),
        refunded: sum("refund"),
        createdAt: { $min: "$createdAt" },
      },
    },
    { $sort: { createdAt: -1, "_id.id": 1 } },
  ];
  if (options.skip) pipeline.push({ $skip: options.skip });
  if (options.limit) pipeline.push({ $limit: options.limit });
  const rows = await entries.aggregate(pipeline, { session }).toArray();
  return rows.map((row) => {
    const grossKobo = Number(row.gross);
    const feesKobo = Number(row.fees);
    const refundedKobo = Number(row.refunded);
    return {
      source: { type: row._id.type, id: row._id.id },
      grossKobo,
      feesKobo,
      refundedKobo,
      netKobo: grossKobo - feesKobo - refundedKobo,
      createdAt: row.createdAt,
    };
  });
}

async function fulfillmentsFor(sources: LedgerSource[], session?: ClientSession) {
  const map = new Map<string, FulfillmentDoc>();
  if (sources.length === 0) return map;
  const { fulfillments } = await db();
  const docs = await fulfillments
    .find({ $or: sources.map((s) => ({ sourceType: s.type, sourceId: s.id })) }, { session })
    .toArray();
  for (const doc of docs) map.set(`${doc.sourceType}:${doc.sourceId}`, doc);
  return map;
}

/**
 * The status of one order's earnings. Only delivered, undisputed earnings
 * whose 24-hour window has passed are available.
 */
export function earningStatus(
  totals: Pick<SourceTotals, "netKobo" | "refundedKobo">,
  fulfillment: Pick<FulfillmentDoc, "deliveredAt" | "disputedAt"> | undefined,
  now: Date,
): { status: EarningStatus; availableAt: Date | null } {
  const availableAt = fulfillment?.deliveredAt
    ? new Date(fulfillment.deliveredAt.getTime() + SETTLEMENT_DELAY_MS)
    : null;
  if (totals.netKobo <= 0 && totals.refundedKobo > 0) return { status: "refunded", availableAt };
  if (fulfillment?.disputedAt) return { status: "under_review", availableAt };
  if (!availableAt) return { status: "awaiting_delivery", availableAt };
  return { status: availableAt.getTime() <= now.getTime() ? "available" : "pending", availableAt };
}

/**
 * The user's balances, derived from their ledger entries at `now`. Pass the
 * transaction's session to read inside withWallet.
 */
export async function getWalletSummary(
  userId: ObjectId,
  options: { now?: Date; session?: ClientSession } = {},
): Promise<WalletSummary> {
  const now = options.now ?? new Date();
  const { entries } = await db();
  const sources = await sourceTotals(userId, {}, options.session);
  const fulfillments = await fulfillmentsFor(
    sources.map((s) => s.source),
    options.session,
  );

  let available = 0;
  let pending = 0;
  let underReview = 0;
  let nextAvailableAt: Date | null = null;
  for (const totals of sources) {
    const { status, availableAt } = earningStatus(
      totals,
      fulfillments.get(`${totals.source.type}:${totals.source.id}`),
      now,
    );
    // what's left of a partly refunded order follows its delivery state; a
    // fully refunded one adds nothing
    if (status === "available" || status === "refunded") available += totals.netKobo;
    else if (status === "under_review") underReview += totals.netKobo;
    else {
      pending += totals.netKobo;
      if (availableAt && (!nextAvailableAt || availableAt < nextAvailableAt)) nextAvailableAt = availableAt;
    }
  }

  let held = 0;
  let paidOut = 0;
  const payoutRows = await entries
    .aggregate(
      [
        { $match: { userId, type: { $in: ["payout_hold", "payout_release", "payout_paid"] } } },
        { $group: { _id: "$type", total: { $sum: "$amountKobo" } } },
      ],
      { session: options.session },
    )
    .toArray();
  for (const row of payoutRows) {
    const effect = ENTRY_EFFECTS[row._id as LedgerEntryType];
    const total = Number(row.total);
    available += effect.available * total;
    held += effect.held * total;
    paidOut += effect.paidOut * total;
  }

  for (const value of [available, pending, underReview, held, paidOut])
    if (!Number.isSafeInteger(value)) throw new Error("Ledger totals are out of range");

  return {
    currency: CURRENCY,
    availableKobo: Math.max(0, available),
    pendingKobo: pending,
    underReviewKobo: underReview,
    heldKobo: held,
    paidOutKobo: paidOut,
    owedKobo: Math.max(0, -available),
    nextAvailableAt: nextAvailableAt?.toISOString() ?? null,
  };
}

/** What the user can withdraw right now; negative when they owe. */
export async function spendableKobo(userId: ObjectId, session: ClientSession): Promise<number> {
  const summary = await getWalletSummary(userId, { session });
  return summary.availableKobo - summary.owedKobo;
}

// --- reading for the screens ------------------------------------------------------

const FILTER_TYPES: Record<TransactionFilter, LedgerEntryType[] | null> = {
  all: null,
  credits: (Object.keys(ENTRY_EFFECTS) as LedgerEntryType[]).filter((t) => ENTRY_EFFECTS[t].direction === "credit"),
  debits: (Object.keys(ENTRY_EFFECTS) as LedgerEntryType[]).filter((t) => ENTRY_EFFECTS[t].direction === "debit"),
  earnings: ["earning", "platform_fee", "refund"],
  payouts: ["payout_hold", "payout_release", "payout_paid"],
};

export function isTransactionFilter(value: string): value is TransactionFilter {
  return Object.hasOwn(FILTER_TYPES, value);
}

const SOURCE_LABEL: Record<EarningSourceType, string> = { order: "order", service_booking: "booking" };

function describe(entry: LedgerEntryDoc): string {
  const label = entry.source ? SOURCE_LABEL[entry.source.type] : "";
  switch (entry.type) {
    case "earning":
      return `Earning from ${label}`;
    case "platform_fee":
      return `Platform fee for ${label}`;
    case "refund":
      return `Refund on ${label}`;
    case "payout_hold":
      return "Payout requested";
    case "payout_release":
      return "Payout failed — amount returned";
    case "payout_paid":
      return "Payout sent to your bank";
  }
}

export const MAX_PAGE_SIZE = 50;

/**
 * The user's ledger entries, newest first, `limit` at a time. `before` is
 * the cursor from the previous page (an entry sequence number).
 */
export async function listTransactions(
  userId: ObjectId,
  options: { filter: TransactionFilter; before: number | null; limit: number; now?: Date },
): Promise<{ transactions: WalletTransaction[]; nextCursor: string | null }> {
  const { entries, payouts } = await db();
  const limit = Math.min(Math.max(1, options.limit), MAX_PAGE_SIZE);
  const query: Document = { userId };
  const types = FILTER_TYPES[options.filter];
  if (types) query.type = { $in: types };
  if (options.before !== null) query.sequence = { $lt: options.before };
  const page = await entries
    .find(query)
    .sort({ sequence: -1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = page.length > limit;
  const rows = page.slice(0, limit);

  // current statuses of the orders and payouts on this page
  const sources = [
    ...new Map(rows.filter((e) => e.source).map((e) => [`${e.source!.type}:${e.source!.id}`, e.source!])).values(),
  ];
  const totals = await sourceTotals(userId, { sources });
  const fulfillments = await fulfillmentsFor(sources);
  const now = options.now ?? new Date();
  const sourceStatus = new Map(
    totals.map((t) => {
      const key = `${t.source.type}:${t.source.id}`;
      return [key, earningStatus(t, fulfillments.get(key), now).status];
    }),
  );
  const payoutIds = [...new Set(rows.flatMap((e) => (e.payoutId ? [e.payoutId.toHexString()] : [])))];
  const payoutDocs = payoutIds.length
    ? await payouts
        .find({ _id: { $in: payoutIds.map((id) => new ObjectId(id)) }, userId })
        .project<Pick<PayoutDoc, "_id" | "status" | "reference">>({ status: 1, reference: 1 })
        .toArray()
    : [];
  const payoutById = new Map(payoutDocs.map((p) => [p._id.toHexString(), p]));

  return {
    transactions: rows.map((entry) => {
      const payout = entry.payoutId ? payoutById.get(entry.payoutId.toHexString()) : undefined;
      return {
        id: entry._id.toHexString(),
        type: entry.type,
        direction: ENTRY_EFFECTS[entry.type].direction,
        amountKobo: entry.amountKobo,
        description: describe(entry),
        reference: entry.source?.id ?? payout?.reference ?? "",
        status: entry.source
          ? (sourceStatus.get(`${entry.source.type}:${entry.source.id}`) ?? null)
          : (payout?.status ?? null),
        createdAt: entry.createdAt.toISOString(),
      };
    }),
    nextCursor: hasMore ? String(rows[rows.length - 1].sequence) : null,
  };
}

/** One row per order or booking the user earned from, newest first. */
export async function listEarnings(
  userId: ObjectId,
  options: { page: number; pageSize: number; now?: Date },
): Promise<{ earnings: Earning[]; hasMore: boolean }> {
  const pageSize = Math.min(Math.max(1, options.pageSize), MAX_PAGE_SIZE);
  const page = Math.max(1, options.page);
  const rows = await sourceTotals(userId, { skip: (page - 1) * pageSize, limit: pageSize + 1 });
  const hasMore = rows.length > pageSize;
  const shown = rows.slice(0, pageSize);
  const fulfillments = await fulfillmentsFor(shown.map((r) => r.source));
  const now = options.now ?? new Date();
  return {
    earnings: shown.map((totals) => {
      const fulfillment = fulfillments.get(`${totals.source.type}:${totals.source.id}`);
      const { status, availableAt } = earningStatus(totals, fulfillment, now);
      return {
        sourceType: totals.source.type,
        reference: totals.source.id,
        grossKobo: totals.grossKobo,
        feesKobo: totals.feesKobo,
        refundedKobo: totals.refundedKobo,
        netKobo: totals.netKobo,
        status,
        deliveredAt: fulfillment?.deliveredAt?.toISOString() ?? null,
        availableAt: availableAt?.toISOString() ?? null,
        createdAt: totals.createdAt.toISOString(),
      };
    }),
    hasMore,
  };
}
