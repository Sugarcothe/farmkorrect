// A minimal fake of the Paystack endpoints the app uses. Nothing reaches
// the real Paystack: tests set up accounts and failures here, and every
// request is recorded so tests can check what was (and wasn't) sent.

export const TEST_PAYSTACK_KEY = "sk_test_fakefakefakefakefake";

import { createHmac } from "node:crypto";

export type PaystackBehaviour =
  | "ok"
  | "reject"
  | "server-error"
  | "malformed"
  | "timeout"
  | "unauthorized"
  // transfers, checkouts and refunds: Paystack creates it, but the response never arrives
  | "timeout-after-create";
type Operation =
  | "banks"
  | "resolve"
  | "recipient"
  | "transfer"
  | "verify"
  | "initialize"
  | "transaction"
  | "refund"
  | "refundFetch"
  | "refundList";

const OK_BEHAVIOUR: Record<Operation, PaystackBehaviour> = {
  banks: "ok",
  resolve: "ok",
  recipient: "ok",
  transfer: "ok",
  verify: "ok",
  initialize: "ok",
  transaction: "ok",
  refund: "ok",
  refundFetch: "ok",
  refundList: "ok",
};

/** A checkout Paystack holds (amount in kobo), by reference. */
export type FakeTransaction = {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  email: string;
  status: string;
  metadata: unknown;
  paid_at: string | null;
};

export type FakeRefund = { id: number; transaction: number; amount: number; status: string; reference: string };

export type FakeTransfer = { reference: string; amount: number; recipient: string; status: string; transfer_code: string };

export const BANKS = [
  { name: "Zenith Bank", code: "057", active: true, is_deleted: false, supports_transfer: true, type: "nuban", currency: "NGN" },
  { name: "Access Bank", code: "044", active: true, is_deleted: false, supports_transfer: true, type: "nuban", currency: "NGN" },
  { name: "Guaranty Trust Bank", code: "058", active: true, is_deleted: false, supports_transfer: true, type: "nuban", currency: "NGN" },
  // filtered out: inactive, deleted, no transfers, not NUBAN
  { name: "Closed Bank", code: "999", active: false, is_deleted: false, supports_transfer: true, type: "nuban", currency: "NGN" },
  { name: "Deleted Bank", code: "998", active: true, is_deleted: true, supports_transfer: true, type: "nuban", currency: "NGN" },
  { name: "No Transfers Bank", code: "997", active: true, is_deleted: false, supports_transfer: false, type: "nuban", currency: "NGN" },
  { name: "Mobile Money", code: "MPS", active: true, is_deleted: false, supports_transfer: true, type: "mobile_money", currency: "NGN" },
];

export const paystack = {
  /** registered account names, by `${bankCode}:${accountNumber}` */
  accounts: new Map<string, string>(),
  behaviour: { ...OK_BEHAVIOUR },
  /** transfers Paystack holds, by reference */
  transfers: new Map<string, FakeTransfer>(),
  /** the status a new transfer gets */
  newTransferStatus: "success",
  /** recipients created, by `${bankCode}:${accountNumber}` (Paystack returns the existing one for a duplicate) */
  recipients: new Map<string, { code: string; name: string; metadata: unknown }>(),
  /** checkouts started, by our reference */
  transactions: new Map<string, FakeTransaction>(),
  /** refunds made, by Paystack id */
  refunds: new Map<number, FakeRefund>(),
  /** the status a new refund gets */
  newRefundStatus: "processed",
  requests: [] as { operation: Operation; method: string; url: string; authorization: string | null; body: unknown }[],
  /** bank list pages served (to check caching) */
  bankListCalls: 0,
};

export function resetPaystack() {
  paystack.accounts.clear();
  paystack.accounts.set("057:0123456789", "ADAEZE OKAFOR");
  paystack.accounts.set("044:1234567890", "ADAEZE  CHIOMA OKAFOR");
  paystack.behaviour = { ...OK_BEHAVIOUR };
  paystack.transactions.clear();
  paystack.refunds.clear();
  paystack.newRefundStatus = "processed";
  paystack.transfers.clear();
  paystack.newTransferStatus = "success";
  paystack.recipients.clear();
  paystack.requests.length = 0;
  paystack.bankListCalls = 0;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function failure(behaviour: PaystackBehaviour): Response | null {
  switch (behaviour) {
    case "timeout": {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    case "unauthorized":
      return json({ status: false, message: "Invalid key" }, 401);
    case "server-error":
      return json({ status: false, message: "Something went wrong" }, 500);
    default:
      return null;
  }
}

export async function fakePaystack(url: URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const operation: Operation | null =
    url.pathname === "/bank"
      ? "banks"
      : url.pathname === "/bank/resolve"
        ? "resolve"
        : url.pathname === "/transferrecipient"
          ? "recipient"
          : url.pathname === "/transfer"
            ? "transfer"
            : url.pathname.startsWith("/transfer/verify/")
              ? "verify"
              : url.pathname === "/transaction/initialize"
                ? "initialize"
                : url.pathname.startsWith("/transaction/verify/")
                  ? "transaction"
                  : url.pathname === "/refund"
                    ? method === "POST"
                      ? "refund"
                      : "refundList"
                    : url.pathname.startsWith("/refund/")
                      ? "refundFetch"
                      : null;
  if (!operation) throw new Error(`Unexpected Paystack request in tests: ${url.pathname}`);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  paystack.requests.push({ operation, method, url: url.toString(), authorization: headers.get("authorization"), body });

  if (headers.get("authorization") !== `Bearer ${TEST_PAYSTACK_KEY}`) return json({ status: false, message: "Invalid key" }, 401);
  const behaviour = paystack.behaviour[operation];
  const failed = failure(behaviour);
  if (failed) return failed;

  if (operation === "banks") {
    paystack.bankListCalls += 1;
    if (behaviour === "malformed") return json({ status: true, data: "not a list" });
    // two pages, to exercise the cursor
    const next = url.searchParams.get("next");
    if (!next) return json({ status: true, data: BANKS.slice(0, 4), meta: { next: "cursor-2", previous: null, perPage: 100 } });
    return json({ status: true, data: BANKS.slice(4), meta: { next: null, previous: "cursor-1", perPage: 100 } });
  }

  if (operation === "resolve") {
    const number = url.searchParams.get("account_number") ?? "";
    const bankCode = url.searchParams.get("bank_code") ?? "";
    if (behaviour === "malformed") return json({ status: true, data: { account_number: number, account_name: 42 } });
    const name = paystack.accounts.get(`${bankCode}:${number}`);
    if (behaviour === "reject" || !name)
      return json({ status: false, message: "Could not resolve account name. Check parameters or try again." }, 422);
    return json({
      status: true,
      message: "Account number resolved",
      data: { account_number: number, account_name: name, bank_id: 9 },
    });
  }

  if (operation === "transfer") return fakeTransfer(method, body, behaviour);
  if (operation === "initialize") return fakeInitialize(body, behaviour);
  if (operation === "transaction") {
    if (behaviour === "malformed") return json({ status: true, data: { reference: 42 } });
    const transaction = paystack.transactions.get(decodeURIComponent(url.pathname.slice("/transaction/verify/".length)));
    if (!transaction) return json({ status: false, message: "Transaction reference not found" }, 400);
    return json({ status: true, message: "Verification successful", data: transactionData(transaction) });
  }
  if (operation === "refund") return fakeRefund(body, behaviour);
  if (operation === "refundFetch") {
    const refund = paystack.refunds.get(Number(url.pathname.slice("/refund/".length)));
    if (!refund) return json({ status: false, message: "Refund not found" }, 404);
    return json({ status: true, message: "Refund retrieved", data: refundData(refund) });
  }
  if (operation === "refundList") {
    const id = Number(url.searchParams.get("transaction"));
    const list = [...paystack.refunds.values()].filter((r) => r.transaction === id);
    return json({ status: true, message: "Refunds retrieved", data: list.map(refundData) });
  }
  if (operation === "verify") {
    if (behaviour === "malformed") return json({ status: true, data: { reference: 42 } });
    const transfer = paystack.transfers.get(decodeURIComponent(url.pathname.slice("/transfer/verify/".length)));
    if (!transfer) return json({ status: false, message: "Transfer not found" }, 404);
    return json({ status: true, message: "Transfer retrieved", data: transferData(transfer) });
  }

  // recipient
  if (method !== "POST") throw new Error("Transfer recipients must be created with POST");
  const input = body as { type: string; name: string; account_number: string; bank_code: string; currency: string; metadata: unknown };
  if (behaviour === "reject") return json({ status: false, message: "Account number is invalid" }, 400);
  if (behaviour === "malformed") return json({ status: true, data: { recipient_code: "not-a-code" } }, 201);
  if (input.type !== "nuban" || input.currency !== "NGN")
    return json({ status: false, message: "Invalid recipient type" }, 400);
  const key = `${input.bank_code}:${input.account_number}`;
  let recipient = paystack.recipients.get(key);
  if (!recipient) {
    recipient = { code: `RCP_test${paystack.recipients.size + 1}abc`, name: input.name, metadata: input.metadata };
    paystack.recipients.set(key, recipient);
  }
  return json(
    {
      status: true,
      message: "Transfer recipient created successfully",
      data: {
        active: true,
        currency: "NGN",
        name: recipient.name,
        recipient_code: recipient.code,
        type: "nuban",
        details: { account_number: input.account_number, account_name: recipient.name, bank_code: input.bank_code, bank_name: "Test Bank" },
      },
    },
    201,
  );
}

function transferData(t: FakeTransfer) {
  return {
    amount: t.amount,
    currency: "NGN",
    reference: t.reference,
    status: t.status,
    transfer_code: t.transfer_code,
    recipient: { recipient_code: t.recipient, type: "nuban" },
  };
}

function fakeTransfer(method: string, body: unknown, behaviour: PaystackBehaviour): Response {
  if (method !== "POST") throw new Error("Transfers must be created with POST");
  const input = body as { source: string; amount: number; recipient: string; reference: string; currency: string };
  if (behaviour === "reject") return json({ status: false, message: "Your balance is not enough to fulfil this request" }, 400);
  if (behaviour === "malformed") return json({ status: true, data: { reference: input.reference, amount: "lots" } });
  if (input.source !== "balance" || input.currency !== "NGN" || !Number.isSafeInteger(input.amount))
    return json({ status: false, message: "Invalid transfer" }, 400);
  if (paystack.transfers.has(input.reference))
    return json({ status: false, message: "Duplicate Transfer Reference" }, 400);
  const transfer: FakeTransfer = {
    reference: input.reference,
    amount: input.amount,
    recipient: input.recipient,
    status: paystack.newTransferStatus,
    transfer_code: `TRF_test${paystack.transfers.size + 1}x`,
  };
  paystack.transfers.set(input.reference, transfer);
  if (behaviour === "timeout-after-create") {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }
  return json({ status: true, message: "Transfer has been queued", data: transferData(transfer) });
}

/** A webhook body for a transfer, and its valid signature. */
export function signedTransferEvent(event: string, transfer: FakeTransfer, key = TEST_PAYSTACK_KEY) {
  const raw = JSON.stringify({ event, data: transferData(transfer) });
  return { raw, signature: createHmac("sha512", key).update(raw).digest("hex") };
}

// --- checkouts and refunds -------------------------------------------------------

let nextId = 4_000_000;

function fakeInitialize(body: unknown, behaviour: PaystackBehaviour): Response {
  const input = body as { email: string; amount: number; currency: string; reference: string; callback_url: string; metadata: unknown };
  if (behaviour === "reject") return json({ status: false, message: "Invalid email" }, 400);
  if (behaviour === "malformed")
    return json({ status: true, data: { authorization_url: "https://evil.example/pay", reference: input.reference } });
  if (paystack.transactions.has(input.reference)) return json({ status: false, message: "Duplicate Transaction Reference" }, 400);
  paystack.transactions.set(input.reference, {
    id: ++nextId,
    reference: input.reference,
    amount: input.amount,
    currency: input.currency,
    email: input.email,
    status: "abandoned",
    metadata: input.metadata,
    paid_at: null,
  });
  if (behaviour === "timeout-after-create") return failure("timeout")!;
  return json({
    status: true,
    message: "Authorization URL created",
    data: {
      authorization_url: `https://checkout.paystack.com/${input.reference.slice(-10)}`,
      access_code: `ac_${input.reference.slice(-10)}`,
      reference: input.reference,
    },
  });
}

function transactionData(t: FakeTransaction) {
  return {
    id: t.id,
    status: t.status,
    reference: t.reference,
    amount: t.amount,
    currency: t.currency,
    paid_at: t.paid_at,
    metadata: t.metadata,
    customer: { email: t.email },
  };
}

/** The buyer completes (or fails) the checkout page; overrides simulate a tampered transaction. */
export function completeCheckout(reference: string, status = "success", overrides: Partial<FakeTransaction> = {}) {
  const transaction = paystack.transactions.get(reference);
  if (!transaction) throw new Error(`No checkout was started for ${reference}`);
  Object.assign(transaction, { status, paid_at: status === "success" ? new Date().toISOString() : null }, overrides);
  return transaction;
}

function fakeRefund(body: unknown, behaviour: PaystackBehaviour): Response {
  const input = body as { transaction: string; amount: number; currency: string; merchant_note: string };
  if (behaviour === "reject") return json({ status: false, message: "Transaction has been fully reversed" }, 400);
  const transaction = paystack.transactions.get(input.transaction);
  if (!transaction || transaction.status !== "success") return json({ status: false, message: "Transaction not found" }, 400);
  const refunded = [...paystack.refunds.values()]
    .filter((r) => r.transaction === transaction.id && r.status !== "failed")
    .reduce((sum, r) => sum + r.amount, 0);
  if (input.amount > transaction.amount - refunded)
    return json({ status: false, message: "Refund amount cannot be greater than transaction amount" }, 400);
  const refund: FakeRefund = {
    id: ++nextId,
    transaction: transaction.id,
    amount: input.amount,
    status: paystack.newRefundStatus,
    reference: transaction.reference,
  };
  paystack.refunds.set(refund.id, refund);
  if (behaviour === "timeout-after-create") return failure("timeout")!;
  return json({ status: true, message: "Refund has been queued for processing", data: refundData(refund) });
}

function refundData(r: FakeRefund) {
  return { id: r.id, transaction: { id: r.transaction, reference: r.reference }, amount: r.amount, currency: "NGN", status: r.status };
}

const sign = (raw: string, key: string) => createHmac("sha512", key).update(raw).digest("hex");

/** A charge.success webhook body for a checkout, and its valid signature. */
export function signedChargeEvent(transaction: FakeTransaction, key = TEST_PAYSTACK_KEY) {
  const raw = JSON.stringify({ event: "charge.success", data: transactionData(transaction) });
  return { raw, signature: sign(raw, key) };
}

/** A refund.* webhook body, and its valid signature. */
export function signedRefundEvent(event: string, refund: FakeRefund, key = TEST_PAYSTACK_KEY) {
  const raw = JSON.stringify({
    event,
    data: { id: refund.id, status: refund.status, amount: refund.amount, currency: "NGN", transaction_reference: refund.reference },
  });
  return { raw, signature: sign(raw, key) };
}
