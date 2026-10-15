import { randomUUID } from "node:crypto";
import { Collection, MongoServerError, type ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { PATCH as replaceAccount } from "@/app/api/bank-details/route";
import { POST as processRoute } from "@/app/api/internal/payouts/process/route";
import { GET as listRoute, POST as requestRoute } from "@/app/api/payouts/route";
import { GET as walletRoute } from "@/app/api/wallet/route";
import { POST as webhookRoute } from "@/app/api/webhooks/paystack/route";
import { recordRefund } from "@/lib/server/ledger";
import { reconcilePayout, runPayoutJob } from "@/lib/server/payouts";
import type { PayoutResponse, PayoutsResponse, WalletResponse } from "@/lib/wallet/types";
import { collections } from "./support/db";
import { newRegistration, registerPending } from "./support/flows";
import { call, dataOf, ORIGIN, type CallResult } from "./support/http";
import { flushAfter } from "./support/outbox";
import { paystack, signedTransferEvent, TEST_PAYSTACK_KEY, type FakeTransfer } from "./support/paystack";
import { ACCESS, addBankAccount, merchant, paidOrder, summaryOf, ZENITH } from "./support/wallet";

// Paystack is faked (tests/support/paystack.ts); new transfers succeed
// immediately unless a test says otherwise.

const JOB_SECRET = "test-payout-job-secret-at-least-32-chars";

const request = (cookie: string, body: unknown, options: { origin?: string | null } = {}) =>
  call<PayoutResponse>(requestRoute, "/api/payouts", { body, cookie, ...options });
const payoutBody = (amountKobo: number, idempotencyKey = randomUUID()) => ({ amountKobo, idempotencyKey });

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

const transferRequests = () => paystack.requests.filter((r) => r.operation === "transfer");

async function storedPayouts() {
  return (await collections()).payouts.find().sort({ createdAt: 1 }).toArray();
}
async function payoutEntries(payoutId?: ObjectId) {
  return (await collections()).ledger
    .find(payoutId ? { payoutId } : { payoutId: { $ne: null } })
    .sort({ sequence: 1 })
    .toArray();
}

/** A merchant with a verified bank account and ₦10,000 available. */
async function readyMerchant(availableKobo = 10_000_00) {
  const m = await merchant();
  await addBankAccount(m.cookie);
  await paidOrder(m.userId, { grossKobo: availableKobo });
  return m;
}

function webhook(raw: string, signature: string | null) {
  const headers = new Headers({ "content-type": "application/json", "x-real-ip": "52.31.139.75" });
  if (signature !== null) headers.set("x-paystack-signature", signature);
  return webhookRoute(new Request(`${ORIGIN}/api/webhooks/paystack`, { method: "POST", headers, body: raw }));
}
const sendEvent = (event: string, transfer: FakeTransfer) => {
  const { raw, signature } = signedTransferEvent(event, transfer);
  return webhook(raw, signature);
};

function processJob(authorization: string | null) {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return processRoute(new Request(`${ORIGIN}/api/internal/payouts/process`, { method: "POST", headers }));
}

function expectNothingSensitiveLogged() {
  const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
  for (const secret of [ZENITH.accountNumber, ACCESS.accountNumber, TEST_PAYSTACK_KEY, "ADAEZE", "RCP_", JOB_SECRET])
    expect(logged).not.toContain(secret);
}

describe("requesting a payout", () => {
  it("holds the amount, sends one transfer to the saved account and marks it paid", async () => {
    const { cookie, userId } = await readyMerchant();
    const res = await request(cookie, payoutBody(4_000_00));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { payout } = dataOf(res);
    expect(payout).toMatchObject({
      amountKobo: 4_000_00,
      currency: "NGN",
      status: "requested",
      bankName: "Zenith Bank",
      accountNumberLast4: "6789",
      failureReason: null,
    });
    expect(payout.reference).toMatch(/^fkp_[0-9a-f]{24}$/);
    expect(JSON.stringify(res.json)).not.toMatch(/RCP_|recipient|0123456789|idempotency/i);
    // held before anything is sent
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 6_000_00, heldKobo: 4_000_00 });
    expect(transferRequests()).toHaveLength(0);

    await flushAfter();
    const [sent] = transferRequests();
    const [{ recipientCode }] = await storedPayouts();
    expect(sent.body).toMatchObject({ source: "balance", amount: 4_000_00, currency: "NGN", reference: payout.reference });
    expect((sent.body as { recipient: string }).recipient).toBe(recipientCode);
    expect(recipientCode).toMatch(/^RCP_/);

    const [stored] = await storedPayouts();
    expect(stored).toMatchObject({ status: "paid", providerStatus: "success", issue: null });
    expect(stored.history.map((h) => h.status)).toEqual(["requested", "processing", "paid"]);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 6_000_00, heldKobo: 0, paidOutKobo: 4_000_00 });
    expect((await payoutEntries()).map((e) => e.type)).toEqual(["payout_hold", "payout_paid"]);

    const list = dataOf(await call<PayoutsResponse>(listRoute, "/api/payouts", { cookie }));
    expect(list.payouts.map((p) => [p.id, p.status])).toEqual([[payout.id, "paid"]]);
    expectNothingSensitiveLogged();
  });

  it("points to Bank Details when there's no verified account", async () => {
    const { cookie, userId } = await merchant();
    await paidOrder(userId);
    const res = await request(cookie, payoutBody(1_000_00));
    expect(res.status).toBe(409);
    expect(fieldErrorsOf(res).bankAccount).toContain("Profile → Bank Details");
    expect(await storedPayouts()).toEqual([]);
  });

  it("refuses more than the available balance, and pending earnings can't be withdrawn", async () => {
    const { cookie, userId } = await readyMerchant(2_000_00);
    await paidOrder(userId, { grossKobo: 50_000_00, deliveredHoursAgo: 2 });
    const res = await request(cookie, payoutBody(2_000_01));
    expect(res.status).toBe(422);
    expect(fieldErrorsOf(res).amountKobo).toContain("₦2,000.00");

    const empty = await merchant("poultry-farmer");
    await addBankAccount(empty.cookie);
    const none = await request(empty.cookie, payoutBody(1_000_00));
    expect(none.status).toBe(422);
    expect(errorOf(none)).toContain("nothing available");
    expect(await storedPayouts()).toEqual([]);
    expect(await payoutEntries()).toEqual([]);
  });

  it("validates the amount and key, and accepts nothing else from the browser", async () => {
    const { cookie } = await readyMerchant();
    const cases: [unknown, string][] = [
      [{ amountKobo: 1000.5, idempotencyKey: randomUUID() }, "amountKobo"],
      [{ amountKobo: "500000", idempotencyKey: randomUUID() }, "amountKobo"],
      [{ amountKobo: -100_00, idempotencyKey: randomUUID() }, "amountKobo"],
      [{ amountKobo: 99_99, idempotencyKey: randomUUID() }, "amountKobo"],
      [{ amountKobo: 1_000_00, idempotencyKey: "abc" }, "idempotencyKey"],
      [{ amountKobo: 1_000_00 }, "idempotencyKey"],
      [{ ...payoutBody(1_000_00), recipientCode: "RCP_attacker" }, "recipientCode"],
      [{ ...payoutBody(1_000_00), accountNumber: "9999999999" }, "accountNumber"],
      [{ ...payoutBody(1_000_00), userId: "abc" }, "userId"],
      [{ ...payoutBody(1_000_00), availableKobo: 99_999_999_00 }, "availableKobo"],
      [{ ...payoutBody(1_000_00), status: "paid" }, "status"],
    ];
    for (const [body, field] of cases) {
      const res = await request(cookie, body);
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty(field);
    }
    expect(await storedPayouts()).toEqual([]);
  });

  it("requires a verified, same-origin session", async () => {
    const { cookie } = await readyMerchant();
    expect((await request(cookie, payoutBody(1_000_00), { origin: "https://evil.example" })).status).toBe(403);
    expect((await call(requestRoute, "/api/payouts", { body: payoutBody(1_000_00) })).status).toBe(401);
    const { pendingCookie } = await registerPending(newRegistration());
    expect((await request(pendingCookie, payoutBody(1_000_00))).status).toBe(403);
    expect((await call(listRoute, "/api/payouts")).status).toBe(401);
    expect(await storedPayouts()).toEqual([]);
  });

  it("refuses requests while transfers are switched off, holding nothing", async () => {
    const { cookie, userId } = await readyMerchant();
    vi.stubEnv("PAYSTACK_TRANSFERS_ENABLED", "false");
    const res = await request(cookie, payoutBody(1_000_00));
    expect(res.status).toBe(503);
    expect(errorOf(res)).toContain("aren't switched on");
    expect(dataOf(await call<WalletResponse>(walletRoute, "/api/wallet", { cookie })).payoutsEnabled).toBe(false);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, heldKobo: 0 });
    expect(await storedPayouts()).toEqual([]);
  });

  it("treats a live key outside production as switched off", async () => {
    const { cookie } = await readyMerchant();
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_notarealkeyjustfortests");
    expect((await request(cookie, payoutBody(1_000_00))).status).toBe(503);
    expect(paystack.requests.filter((r) => r.operation === "transfer")).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("notarealkey");
  });

  it("returns the same payout when a request is repeated, and refuses a changed amount", async () => {
    const { cookie, userId } = await readyMerchant();
    const body = payoutBody(3_000_00);
    const first = await request(cookie, body);
    const again = await request(cookie, { ...body, idempotencyKey: body.idempotencyKey.toUpperCase() });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(dataOf(again).payout.id).toBe(dataOf(first).payout.id);
    expect((await request(cookie, { ...body, amountKobo: 3_000_01 })).status).toBe(409);
    await flushAfter();
    expect(transferRequests()).toHaveLength(1);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 7_000_00, paidOutKobo: 3_000_00 });
  });

  it("creates one payout from simultaneous duplicate submissions", async () => {
    const { cookie, userId } = await readyMerchant();
    const body = payoutBody(5_000_00);
    const results = await Promise.all(Array.from({ length: 5 }, () => request(cookie, body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => dataOf(r).payout.id)).size).toBe(1);
    expect(await storedPayouts()).toHaveLength(1);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 5_000_00, heldKobo: 5_000_00 });
  });

  it("never lets simultaneous payouts spend the same money twice", async () => {
    const { cookie, userId } = await readyMerchant();
    const results = await Promise.all(Array.from({ length: 4 }, () => request(cookie, payoutBody(6_000_00))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422, 422]);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 4_000_00, heldKobo: 6_000_00 });
    await flushAfter();
    expect(transferRequests()).toHaveLength(1);
  });

  it("saves nothing when the database fails mid-request", async () => {
    const { cookie, userId } = await readyMerchant();
    const original = Collection.prototype.insertMany;
    const spy = vi.spyOn(Collection.prototype, "insertMany").mockImplementation(function (
      this: Collection,
      ...args: Parameters<Collection["insertMany"]>
    ) {
      if (this.collectionName === "ledger_entries" && args[1]?.session)
        throw new MongoServerError({ message: "simulated outage" });
      return original.apply(this, args);
    } as Collection["insertMany"]);
    const res = await request(cookie, payoutBody(1_000_00));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toMatch(/simulated|Mongo/);
    expect(await storedPayouts()).toEqual([]);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, heldKobo: 0 });
  });
});

describe("transfer failures and recovery", () => {
  it("returns the held amount exactly once when Paystack rejects the transfer", async () => {
    const { cookie, userId } = await readyMerchant();
    paystack.behaviour.transfer = "reject";
    await request(cookie, payoutBody(4_000_00));
    await flushAfter();
    const [stored] = await storedPayouts();
    expect(stored).toMatchObject({ status: "failed", failureReason: "provider_rejected" });
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, heldKobo: 0, paidOutKobo: 0 });

    // later reports can't release it again
    await reconcilePayout(stored._id);
    await sendEvent("transfer.failed", {
      reference: stored.reference,
      amount: 4_000_00,
      recipient: stored.recipientCode,
      status: "failed",
      transfer_code: "TRF_x",
    });
    expect((await payoutEntries()).map((e) => e.type)).toEqual(["payout_hold", "payout_release"]);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, heldKobo: 0 });
  });

  it("fails without retrying when the transfer key is refused", async () => {
    const { cookie, userId } = await readyMerchant();
    paystack.behaviour.transfer = "unauthorized";
    await request(cookie, payoutBody(4_000_00));
    await flushAfter();
    expect((await storedPayouts())[0]).toMatchObject({ status: "failed", failureReason: "transfers_misconfigured" });
    expect((await summaryOf(userId)).availableKobo).toBe(10_000_00);
  });

  it("keeps the amount held after a timeout, then fails it once Paystack confirms there's no transfer", async () => {
    const { cookie, userId } = await readyMerchant();
    paystack.behaviour.transfer = "timeout";
    await request(cookie, payoutBody(4_000_00));
    await flushAfter();
    let [stored] = await storedPayouts();
    expect(stored).toMatchObject({ status: "processing", providerStatus: "unknown" });
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 6_000_00, heldKobo: 4_000_00 });

    // within the grace period, "not found" isn't trusted yet
    paystack.behaviour.transfer = "ok";
    await reconcilePayout(stored._id);
    expect((await storedPayouts())[0].status).toBe("processing");

    await (await collections()).payouts.updateOne(
      { _id: stored._id },
      { $set: { transferInitiatedAt: new Date(Date.now() - 31 * 60_000) } },
    );
    await reconcilePayout(stored._id);
    [stored] = await storedPayouts();
    expect(stored).toMatchObject({ status: "failed", failureReason: "not_found_at_provider" });
    expect(transferRequests()).toHaveLength(1);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, heldKobo: 0 });
  });

  it("settles a transfer that went through before the response was lost, without sending it again", async () => {
    const { cookie, userId } = await readyMerchant();
    paystack.behaviour.transfer = "timeout-after-create";
    await request(cookie, payoutBody(4_000_00));
    await flushAfter();
    const [stored] = await storedPayouts();
    expect(stored.status).toBe("processing");

    paystack.behaviour.transfer = "ok";
    await reconcilePayout(stored._id);
    await reconcilePayout(stored._id);
    expect((await storedPayouts())[0].status).toBe("paid");
    expect(transferRequests()).toHaveLength(1);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 6_000_00, heldKobo: 0, paidOutKobo: 4_000_00 });
  });

  it("leaves the payout untouched while Paystack can't be reached for a check", async () => {
    const { cookie, userId } = await readyMerchant();
    paystack.behaviour.transfer = "timeout";
    await request(cookie, payoutBody(4_000_00));
    await flushAfter();
    paystack.behaviour.verify = "server-error";
    const [stored] = await storedPayouts();
    await (await collections()).payouts.updateOne(
      { _id: stored._id },
      { $set: { transferInitiatedAt: new Date(Date.now() - 60 * 60_000) } },
    );
    await reconcilePayout(stored._id);
    expect((await storedPayouts())[0].status).toBe("processing");
    expect((await summaryOf(userId)).heldKobo).toBe(4_000_00);
  });

  it("doesn't send to an account that was replaced after the request", async () => {
    const { cookie, userId } = await readyMerchant();
    await request(cookie, payoutBody(4_000_00));
    await addBankAccount(cookie, ACCESS, replaceAccount);
    await flushAfter();
    expect(transferRequests()).toHaveLength(0);
    expect((await storedPayouts())[0]).toMatchObject({ status: "failed", failureReason: "account_changed", bankName: "Zenith Bank" });
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, heldKobo: 0 });
  });

  it("explains money owed when a refund lands after a payout", async () => {
    const { cookie, userId } = await merchant();
    await addBankAccount(cookie);
    const id = await paidOrder(userId, { grossKobo: 10_000_00 });
    await request(cookie, payoutBody(10_000_00));
    await flushAfter();
    await recordRefund({ sourceType: "order", sourceId: id, refundId: "rf_1", amountKobo: 3_000_00, currency: "NGN" });
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 0, owedKobo: 3_000_00, paidOutKobo: 10_000_00 });
    // new earnings cover what's owed first
    await paidOrder(userId, { grossKobo: 5_000_00 });
    const res = await request(cookie, payoutBody(2_000_01));
    expect(res.status).toBe(422);
    expect((await request(cookie, payoutBody(2_000_00))).status).toBe(201);
  });
});

describe("Paystack webhooks", () => {
  async function processingPayout() {
    const m = await readyMerchant();
    paystack.newTransferStatus = "pending";
    await request(m.cookie, payoutBody(4_000_00));
    await flushAfter();
    const [stored] = await storedPayouts();
    expect(stored).toMatchObject({ status: "processing", providerStatus: "pending" });
    const transfer = paystack.transfers.get(stored.reference)!;
    return { ...m, stored, transfer };
  }

  it("marks a pending transfer paid once, however often the event arrives", async () => {
    const { userId, transfer } = await processingPayout();
    transfer.status = "success";
    const responses = await Promise.all([1, 2, 3].map(() => sendEvent("transfer.success", transfer)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(responses[0].headers.get("cache-control")).toBe("no-store");
    expect((await storedPayouts())[0].status).toBe("paid");
    expect((await payoutEntries()).map((e) => e.type)).toEqual(["payout_hold", "payout_paid"]);
    expect(await summaryOf(userId)).toMatchObject({ heldKobo: 0, paidOutKobo: 4_000_00 });
    expect(await (await collections()).providerEvents.countDocuments()).toBe(1);
  });

  it("returns the amount when a transfer fails", async () => {
    const { userId, transfer } = await processingPayout();
    transfer.status = "failed";
    expect((await sendEvent("transfer.failed", transfer)).status).toBe(200);
    expect((await storedPayouts())[0]).toMatchObject({ status: "failed", failureReason: "provider_failed" });
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, heldKobo: 0 });
  });

  it("flags a contradicting late event instead of moving money", async () => {
    const { userId, stored, transfer } = await processingPayout();
    transfer.status = "failed";
    await sendEvent("transfer.failed", transfer);
    transfer.status = "success";
    await sendEvent("transfer.success", transfer);
    let [after] = await storedPayouts();
    expect(after).toMatchObject({ status: "failed" });
    expect(after.issue).toContain("success reported while failed");
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 10_000_00, paidOutKobo: 0 });

    // and the other way round: a reversal after payment
    const other = await processingPaidThenReversed();
    [after] = (await storedPayouts()).filter((p) => p._id.equals(other));
    expect(after.status).toBe("paid");
    expect(after.issue).toContain("reported after payment");
    expect(stored._id.equals(other)).toBe(false);
  });

  async function processingPaidThenReversed() {
    const m = await merchant("poultry-farmer");
    await addBankAccount(m.cookie, ACCESS);
    await paidOrder(m.userId, { grossKobo: 2_000_00 });
    paystack.newTransferStatus = "success";
    const { payout } = dataOf(await request(m.cookie, payoutBody(2_000_00)));
    await flushAfter();
    const transfer = paystack.transfers.get(payout.reference)!;
    transfer.status = "reversed";
    await sendEvent("transfer.reversed", transfer);
    expect(await summaryOf(m.userId)).toMatchObject({ paidOutKobo: 2_000_00, availableKobo: 0 });
    return (await storedPayouts()).find((p) => p.reference === payout.reference)!._id;
  }

  it("flags events whose details don't match the payout", async () => {
    const { userId, transfer } = await processingPayout();
    await sendEvent("transfer.success", { ...transfer, status: "success", amount: 400_000_00 });
    let [stored] = await storedPayouts();
    expect(stored.status).toBe("processing");
    expect(stored.issue).toContain("don't match");

    await (await collections()).payouts.updateOne({ _id: stored._id }, { $set: { issue: null } });
    await sendEvent("transfer.success", { ...transfer, status: "success", recipient: "RCP_someoneelse" });
    // event name and status disagree
    await sendEvent("transfer.success", { ...transfer, status: "failed" });
    [stored] = await storedPayouts();
    expect(stored.status).toBe("processing");
    expect(stored.issue).toBeTruthy();
    expect((await summaryOf(userId)).heldKobo).toBe(4_000_00);
  });

  it("rejects unsigned and tampered events", async () => {
    const { transfer } = await processingPayout();
    transfer.status = "success";
    const { raw, signature } = signedTransferEvent("transfer.success", transfer);
    expect((await webhook(raw, null)).status).toBe(401);
    expect((await webhook(raw, "0".repeat(128))).status).toBe(401);
    expect((await webhook(raw, "not-hex")).status).toBe(401);
    expect((await webhook(raw.replace("400000", "900000"), signature)).status).toBe(401);
    const wrongKey = signedTransferEvent("transfer.success", transfer, "sk_test_someoneelse");
    expect((await webhook(wrongKey.raw, wrongKey.signature)).status).toBe(401);
    expect((await storedPayouts())[0].status).toBe("processing");
    expect(await (await collections()).providerEvents.countDocuments()).toBe(0);
  });

  it("acknowledges events it doesn't use, and unknown references, without changes", async () => {
    await processingPayout();
    const other = signedTransferEvent("charge.success", {
      reference: "x",
      amount: 1,
      recipient: "RCP_x",
      status: "success",
      transfer_code: "TRF_x",
    });
    expect((await webhook(other.raw, other.signature)).status).toBe(200);
    const unknown = await sendEvent("transfer.success", {
      reference: "fkp_000000000000000000000000",
      amount: 4_000_00,
      recipient: "RCP_x",
      status: "success",
      transfer_code: "TRF_x",
    });
    expect(unknown.status).toBe(200);
    expect((await storedPayouts())[0].status).toBe("processing");
  });

  it("answers 500 when the database fails, so Paystack retries, then applies the retry", async () => {
    const { transfer } = await processingPayout();
    transfer.status = "success";
    const original = Collection.prototype.findOneAndUpdate;
    const spy = vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(function (
      this: Collection,
      ...args: unknown[]
    ) {
      if (this.collectionName === "payouts") throw new MongoServerError({ message: "simulated outage" });
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    const failed = await sendEvent("transfer.success", transfer);
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect(await (await collections()).providerEvents.countDocuments()).toBe(0);
    expect((await storedPayouts())[0].status).toBe("processing");

    expect((await sendEvent("transfer.success", transfer)).status).toBe(200);
    expect((await storedPayouts())[0].status).toBe("paid");
    expectNothingSensitiveLogged();
  });
});

describe("the processing job", () => {
  it("is hidden without a secret and needs the right one", async () => {
    vi.stubEnv("PAYOUT_JOB_SECRET", "");
    expect((await processJob(`Bearer ${JOB_SECRET}`)).status).toBe(404);
    vi.stubEnv("PAYOUT_JOB_SECRET", JOB_SECRET);
    expect((await processJob(null)).status).toBe(401);
    expect((await processJob("Bearer wrong")).status).toBe(401);
    expect((await processJob(JOB_SECRET)).status).toBe(401);
    const res = await processJob(`Bearer ${JOB_SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { sent: 0, checked: 0 } });
  });

  it("sends requested payouts the background step missed, and settles stale ones", async () => {
    const { cookie, userId } = await readyMerchant();
    await request(cookie, payoutBody(1_000_00));
    // the background step never ran (e.g. the server restarted)
    expect((await runPayoutJob()).sent).toBe(1);
    expect((await storedPayouts())[0].status).toBe("paid");

    paystack.newTransferStatus = "pending";
    await request(cookie, payoutBody(2_000_00));
    await flushAfter();
    const stale = (await storedPayouts())[1];
    paystack.transfers.get(stale.reference)!.status = "success";
    await (await collections()).payouts.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } },
    );
    expect(await runPayoutJob()).toEqual({ sent: 0, checked: 1 });
    expect((await storedPayouts())[1].status).toBe("paid");
    expect(transferRequests()).toHaveLength(2);
    expect(await summaryOf(userId)).toMatchObject({ availableKobo: 7_000_00, paidOutKobo: 3_000_00, heldKobo: 0 });
  });
});
