import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { GET as walletRoute } from "@/app/api/wallet/route";
import { GET as earningsRoute } from "@/app/api/wallet/earnings/route";
import { GET as transactionsRoute } from "@/app/api/wallet/transactions/route";
import {
  closeDispute,
  ENTRY_EFFECTS,
  getWalletSummary,
  LedgerConflictError,
  LedgerValidationError,
  listEarnings,
  openDispute,
  recordDelivery,
  recordEarning,
  recordRefund,
} from "@/lib/server/ledger";
import { formatKobo, koboToInput, parseNairaToKobo } from "@/lib/wallet/money";
import type { EarningsResponse, TransactionsResponse, WalletResponse } from "@/lib/wallet/types";
import { collections } from "./support/db";
import { newRegistration, registerPending } from "./support/flows";
import { call, dataOf } from "./support/http";
import { HOUR, merchant, paidOrder, summaryOf } from "./support/wallet";

const wallet = (cookie?: string) => call<WalletResponse>(walletRoute, "/api/wallet", { cookie });
const transactions = (cookie: string, query = "") =>
  call<TransactionsResponse>(transactionsRoute, `/api/wallet/transactions${query}`, { cookie });
const earnings = (cookie: string, query = "") =>
  call<EarningsResponse>(earningsRoute, `/api/wallet/earnings${query}`, { cookie });

const earning = (userId: ObjectId, overrides: Partial<Parameters<typeof recordEarning>[0]> = {}) =>
  recordEarning({
    merchantUserId: userId,
    sourceType: "order",
    sourceId: "ord_1",
    paymentReference: "pay_1",
    grossKobo: 5_000_00,
    platformFeeKobo: 0,
    currency: "NGN",
    ...overrides,
  });

async function ledgerCount() {
  return (await collections()).ledger.countDocuments();
}

describe("money helpers", () => {
  it("formats kobo without floating point", () => {
    expect(formatKobo(0)).toBe("₦0.00");
    expect(formatKobo(1)).toBe("₦0.01");
    expect(formatKobo(123_456_78)).toBe("₦123,456.78");
    expect(formatKobo(-50_00)).toBe("−₦50.00");
  });

  it("parses naira input into integer kobo", () => {
    expect(parseNairaToKobo("1,500")).toBe(1_500_00);
    expect(parseNairaToKobo("₦2,000.5")).toBe(2_000_50);
    expect(parseNairaToKobo("0.07")).toBe(7);
    // 0.1 + 0.2 style inputs stay exact
    expect(parseNairaToKobo("19.99")).toBe(1999);
    for (const bad of ["", "abc", "1.234", "-5", "1e5", "12.", " . "]) expect(parseNairaToKobo(bad)).toBeNull();
    expect(koboToInput(1_500_00)).toBe("1500");
    expect(koboToInput(1_500_05)).toBe("1500.05");
  });
});

describe("ledger entry types", () => {
  it("defines how every entry type moves each balance", () => {
    expect(ENTRY_EFFECTS).toEqual({
      earning: { sourceNet: 1, available: 0, held: 0, paidOut: 0, direction: "credit" },
      platform_fee: { sourceNet: -1, available: 0, held: 0, paidOut: 0, direction: "debit" },
      refund: { sourceNet: -1, available: 0, held: 0, paidOut: 0, direction: "debit" },
      payout_hold: { sourceNet: 0, available: -1, held: 1, paidOut: 0, direction: "debit" },
      payout_release: { sourceNet: 0, available: 1, held: -1, paidOut: 0, direction: "credit" },
      payout_paid: { sourceNet: 0, available: 0, held: -1, paidOut: 1, direction: "none" },
    });
  });
});

describe("GET /api/wallet", () => {
  it("shows zeros and no transactions for a new user, uncached", async () => {
    const { cookie } = await merchant();
    const res = await wallet(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(dataOf(res)).toEqual({
      summary: {
        currency: "NGN",
        availableKobo: 0,
        pendingKobo: 0,
        underReviewKobo: 0,
        heldKobo: 0,
        paidOutKobo: 0,
        owedKobo: 0,
        nextAvailableAt: null,
      },
      recent: [],
      destination: null,
      payoutsEnabled: true,
    });
    expect(await (await collections()).wallets.countDocuments()).toBe(0);
  });

  it("requires a verified session", async () => {
    expect((await wallet()).status).toBe(401);
    expect((await wallet("not-a-session")).status).toBe(401);
    const { pendingCookie } = await registerPending(newRegistration());
    expect((await wallet(pendingCookie)).status).toBe(403);
    expect((await transactions(pendingCookie)).status).toBe(403);
    expect((await earnings(pendingCookie)).status).toBe(403);
  });

  it("only ever shows the signed-in user's money", async () => {
    const a = await merchant();
    const b = await merchant("poultry-farmer");
    await paidOrder(a.userId, { grossKobo: 7_000_00 });
    const bWallet = dataOf(await wallet(b.cookie));
    expect(bWallet.summary.availableKobo).toBe(0);
    expect(bWallet.recent).toEqual([]);
    expect(dataOf(await transactions(b.cookie)).transactions).toEqual([]);
    expect(dataOf(await earnings(b.cookie)).earnings).toEqual([]);
    // a user id in the query is ignored, not used
    const res = await call<WalletResponse>(walletRoute, `/api/wallet?userId=${a.userId.toHexString()}`, {
      cookie: b.cookie,
    });
    expect(dataOf(res).summary.availableKobo).toBe(0);
  });
});

describe("the 24-hour availability rule", () => {
  it("keeps paid but undelivered earnings pending", async () => {
    const { userId } = await merchant();
    await paidOrder(userId, { grossKobo: 3_000_00, deliveredHoursAgo: null });
    const summary = await summaryOf(userId);
    expect(summary).toMatchObject({ availableKobo: 0, pendingKobo: 3_000_00, nextAvailableAt: null });
  });

  it("makes earnings available exactly 24 hours after delivery", async () => {
    const { userId } = await merchant();
    const deliveredAt = new Date(Date.now() - 2 * HOUR);
    await earning(userId);
    await recordDelivery({ sourceType: "order", sourceId: "ord_1", deliveredAt });
    const at = (ms: number) => getWalletSummary(userId, { now: new Date(deliveredAt.getTime() + ms) });

    const before = await at(24 * HOUR - 1);
    expect(before).toMatchObject({ availableKobo: 0, pendingKobo: 5_000_00 });
    expect(before.nextAvailableAt).toBe(new Date(deliveredAt.getTime() + 24 * HOUR).toISOString());
    expect(await at(24 * HOUR)).toMatchObject({ availableKobo: 5_000_00, pendingKobo: 0, nextAvailableAt: null });
  });

  it("separates pending from available and shows fees as deductions", async () => {
    const { userId, cookie } = await merchant();
    await paidOrder(userId, { grossKobo: 10_000_00, feeKobo: 1_500_00, deliveredHoursAgo: 30, id: "ord_old" });
    await paidOrder(userId, { grossKobo: 4_000_00, feeKobo: 0, deliveredHoursAgo: 3, id: "ord_new" });
    const { summary } = dataOf(await wallet(cookie));
    expect(summary).toMatchObject({ availableKobo: 8_500_00, pendingKobo: 4_000_00 });

    const list = dataOf(await earnings(cookie)).earnings;
    expect(list.map((e) => [e.reference, e.grossKobo, e.feesKobo, e.netKobo, e.status])).toEqual([
      ["ord_new", 4_000_00, 0, 4_000_00, "pending"],
      ["ord_old", 10_000_00, 1_500_00, 8_500_00, "available"],
    ]);
    expect(list[0].availableAt).toBe(new Date(new Date(list[0].deliveredAt!).getTime() + 24 * HOUR).toISOString());
  });

  it("keeps the first delivery time: it can't be moved earlier or later", async () => {
    const { userId } = await merchant();
    await earning(userId);
    const first = new Date(Date.now() - 2 * HOUR);
    expect(await recordDelivery({ sourceType: "order", sourceId: "ord_1", deliveredAt: first })).toEqual({
      deliveredAt: first,
      changed: true,
    });
    const again = await recordDelivery({ sourceType: "order", sourceId: "ord_1", deliveredAt: new Date(Date.now() - 48 * HOUR) });
    expect(again).toEqual({ deliveredAt: first, changed: false });
    expect((await summaryOf(userId)).availableKobo).toBe(0);
  });

  it("refuses delivery times in the future", async () => {
    const { userId } = await merchant();
    await earning(userId);
    await expect(
      recordDelivery({ sourceType: "order", sourceId: "ord_1", deliveredAt: new Date(Date.now() + HOUR) }),
    ).rejects.toThrow(LedgerValidationError);
  });

  it("handles repeated, concurrent delivery events once", async () => {
    const { userId } = await merchant();
    await earning(userId);
    const times = [30, 31, 32, 33].map((h) => new Date(Date.now() - h * HOUR));
    const results = await Promise.all(
      times.map((deliveredAt) => recordDelivery({ sourceType: "order", sourceId: "ord_1", deliveredAt })),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.deliveredAt.getTime())).size).toBe(1);
    expect(await (await collections()).fulfillments.countDocuments()).toBe(1);
  });

  it("holds disputed earnings until the dispute closes", async () => {
    const { userId } = await merchant();
    const id = await paidOrder(userId, { grossKobo: 2_000_00 });
    await openDispute({ sourceType: "order", sourceId: id });
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 0, underReviewKobo: 2_000_00 });
    await closeDispute({ sourceType: "order", sourceId: id });
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 2_000_00, underReviewKobo: 0 });
  });
});

describe("recording earnings", () => {
  it("requires a confirmed payment and valid integer amounts in NGN", async () => {
    const { userId } = await merchant();
    const bad: Partial<Parameters<typeof recordEarning>[0]>[] = [
      { paymentReference: "" },
      { grossKobo: 10.5 },
      { grossKobo: 0 },
      { grossKobo: -100 },
      { grossKobo: Number.MAX_SAFE_INTEGER },
      { platformFeeKobo: 6_000_00 },
      { platformFeeKobo: -1 },
      { platformFeeKobo: 0.5 },
      { currency: "USD" },
      { sourceId: "has spaces" },
      { sourceType: "gift" as never },
    ];
    for (const overrides of bad) await expect(earning(userId, overrides)).rejects.toThrow(LedgerValidationError);
    expect(await ledgerCount()).toBe(0);
  });

  it("records the same payment only once, even when repeated concurrently", async () => {
    const { userId } = await merchant();
    const results = await Promise.all(Array.from({ length: 5 }, () => earning(userId, { platformFeeKobo: 500_00 })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const entries = await (await collections()).ledger.find().toArray();
    expect(entries.map((e) => e.type).sort()).toEqual(["earning", "platform_fee"]);
    expect((await summaryOf(userId)).pendingKobo).toBe(4_500_00);
  });

  it("refuses to record the same order again with different values", async () => {
    const { userId } = await merchant();
    const other = await merchant("poultry-farmer");
    await earning(userId);
    await expect(earning(userId, { grossKobo: 9_000_00 })).rejects.toThrow(LedgerConflictError);
    await expect(earning(userId, { platformFeeKobo: 100 })).rejects.toThrow(LedgerConflictError);
    await expect(earning(other.userId)).rejects.toThrow(LedgerConflictError);
    expect(await ledgerCount()).toBe(1);
  });

  it("gives each user's entries an increasing sequence", async () => {
    const { userId } = await merchant();
    await Promise.all([1, 2, 3, 4].map((n) => paidOrder(userId, { feeKobo: 100, deliveredHoursAgo: null, id: `ord_s${n}` })));
    const sequences = (await (await collections()).ledger.find({ userId }).toArray()).map((e) => e.sequence);
    expect(sequences.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("refunds", () => {
  it("reduces pending earnings when refunded before they're available", async () => {
    const { userId } = await merchant();
    const id = await paidOrder(userId, { grossKobo: 5_000_00, feeKobo: 500_00, deliveredHoursAgo: 1 });
    await recordRefund({ sourceType: "order", sourceId: id, refundId: "rf_1", amountKobo: 1_000_00, currency: "NGN" });
    expect(await summaryOf(userId)).toMatchObject({ pendingKobo: 3_500_00, availableKobo: 0 });
  });

  it("never refunds more than is left of the earning, and records each refund once", async () => {
    const { userId } = await merchant();
    const id = await paidOrder(userId, { grossKobo: 5_000_00, feeKobo: 500_00 });
    const refund = (refundId: string, amountKobo: number) =>
      recordRefund({ sourceType: "order", sourceId: id, refundId, amountKobo, currency: "NGN" });
    await expect(refund("rf_x", 4_500_01)).rejects.toThrow(LedgerValidationError);
    expect((await refund("rf_1", 4_000_00)).created).toBe(true);
    expect((await refund("rf_1", 4_000_00)).created).toBe(false);
    await expect(refund("rf_1", 3_000_00)).rejects.toThrow(LedgerConflictError);
    await expect(refund("rf_2", 500_01)).rejects.toThrow(LedgerValidationError);
    await refund("rf_2", 500_00);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 0, pendingKobo: 0, owedKobo: 0 });
    const [row] = (await earningsOf(userId)).earnings;
    expect(row).toMatchObject({ status: "refunded", refundedKobo: 4_500_00, netKobo: 0 });
  });

  it("refuses refunds for orders with no earning", async () => {
    await expect(
      recordRefund({ sourceType: "order", sourceId: "ord_none", refundId: "rf_1", amountKobo: 100, currency: "NGN" }),
    ).rejects.toThrow(LedgerValidationError);
  });

  it("allows concurrent refunds only up to the remaining amount", async () => {
    const { userId } = await merchant();
    const id = await paidOrder(userId, { grossKobo: 3_000_00 });
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        recordRefund({ sourceType: "order", sourceId: id, refundId: `rf_${n}`, amountKobo: 2_000_00, currency: "NGN" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await summaryOf(userId)).availableKobo).toBe(1_000_00);
  });
});

const earningsOf = (userId: ObjectId) => listEarnings(userId, { page: 1, pageSize: 20 });

describe("transaction history", () => {
  it("pages through entries newest first, without gaps or repeats", async () => {
    const { userId, cookie } = await merchant();
    for (let n = 1; n <= 13; n++) await paidOrder(userId, { feeKobo: 100, deliveredHoursAgo: null, id: `ord_${n}` });

    const first = dataOf(await transactions(cookie));
    expect(first.transactions).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const second = dataOf(await transactions(cookie, `?before=${first.nextCursor}`));
    expect(second.transactions).toHaveLength(6);
    expect(second.nextCursor).toBeNull();

    const all = [...first.transactions, ...second.transactions];
    expect(new Set(all.map((t) => t.id)).size).toBe(26);
    const times = all.map((t) => t.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(all[0]).toMatchObject({
      type: "platform_fee",
      direction: "debit",
      amountKobo: 100,
      reference: "ord_13",
      status: "awaiting_delivery",
      description: "Platform fee for order",
    });
    // nothing internal leaks into the list
    expect(JSON.stringify(all)).not.toMatch(/userId|idempotency|paymentReference|recipient|sequence/);
  });

  it("filters by credits, debits, earnings and payouts", async () => {
    const { userId, cookie } = await merchant();
    await paidOrder(userId, { feeKobo: 100 });
    const of = async (filter: string) =>
      dataOf(await transactions(cookie, `?filter=${filter}`)).transactions.map((t) => t.type);
    expect(await of("credits")).toEqual(["earning"]);
    expect(await of("debits")).toEqual(["platform_fee"]);
    expect(await of("earnings")).toEqual(["platform_fee", "earning"]);
    expect(await of("payouts")).toEqual([]);
  });

  it("rejects invalid filters and cursors", async () => {
    const { cookie } = await merchant();
    for (const query of ["?filter=everything", "?before=abc", "?before=0", "?limit=500", "?before=1e3"])
      expect((await transactions(cookie, query)).status).toBe(400);
    expect((await earnings(cookie, "?page=0")).status).toBe(400);
  });

  it("pages earnings", async () => {
    const { userId, cookie } = await merchant();
    for (let n = 1; n <= 21; n++) await paidOrder(userId, { deliveredHoursAgo: null, id: `ord_${n}` });
    const one = dataOf(await earnings(cookie));
    const two = dataOf(await earnings(cookie, "?page=2"));
    expect([one.earnings.length, one.hasMore, two.earnings.length, two.hasMore]).toEqual([20, true, 1, false]);
    expect(two.earnings[0].reference).toBe("ord_1");
  });

  it("never changes an entry once written", async () => {
    const { userId } = await merchant();
    const id = await paidOrder(userId, { feeKobo: 200_00 });
    const before = await (await collections()).ledger.find().toArray();
    await recordDelivery({ sourceType: "order", sourceId: id, deliveredAt: new Date() });
    await openDispute({ sourceType: "order", sourceId: id });
    await closeDispute({ sourceType: "order", sourceId: id });
    await recordRefund({ sourceType: "order", sourceId: id, refundId: "rf_1", amountKobo: 100, currency: "NGN" });
    const after = await (await collections()).ledger.find({ _id: { $in: before.map((e) => e._id) } }).toArray();
    expect(after).toEqual(before);
  });
});
