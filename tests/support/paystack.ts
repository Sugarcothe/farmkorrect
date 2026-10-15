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
  // transfers only: Paystack creates the transfer, but the response never arrives
  | "timeout-after-create";
type Operation = "banks" | "resolve" | "recipient" | "transfer" | "verify";

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
  behaviour: { banks: "ok", resolve: "ok", recipient: "ok", transfer: "ok", verify: "ok" } as Record<
    Operation,
    PaystackBehaviour
  >,
  /** transfers Paystack holds, by reference */
  transfers: new Map<string, FakeTransfer>(),
  /** the status a new transfer gets */
  newTransferStatus: "success",
  /** recipients created, by `${bankCode}:${accountNumber}` (Paystack returns the existing one for a duplicate) */
  recipients: new Map<string, { code: string; name: string; metadata: unknown }>(),
  requests: [] as { operation: Operation; method: string; url: string; authorization: string | null; body: unknown }[],
  /** bank list pages served (to check caching) */
  bankListCalls: 0,
};

export function resetPaystack() {
  paystack.accounts.clear();
  paystack.accounts.set("057:0123456789", "ADAEZE OKAFOR");
  paystack.accounts.set("044:1234567890", "ADAEZE  CHIOMA OKAFOR");
  paystack.behaviour = { banks: "ok", resolve: "ok", recipient: "ok", transfer: "ok", verify: "ok" };
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
