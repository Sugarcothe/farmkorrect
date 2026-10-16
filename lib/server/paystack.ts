import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigError, getPaystackConfig, type PaystackConfig } from "./config";

// A small client for the Paystack calls the app makes: the bank list,
// account-name resolution and transfer recipients (bank details), transfers
// and their verification (payouts), transactions and refunds (order
// payments), and webhook signatures. Requests
// are made from the server with the secret key, which never leaves it.
// Responses are validated field by field; nothing from Paystack is logged
// (only the operation and HTTP status) or passed on as-is.

export const PAYSTACK_API = "https://api.paystack.co";
const TIMEOUT_MS = 10_000;

/**
 * - "rejected": Paystack understood the request and said no (e.g. the account
 *   doesn't exist)
 * - "unavailable": Paystack couldn't be reached, timed out, was overloaded or
 *   answered with something we couldn't trust
 * - "misconfigured": the secret key is missing or Paystack refused it
 */
export type PaystackFailure = "rejected" | "unavailable" | "misconfigured";

export class PaystackError extends Error {
  constructor(readonly failure: PaystackFailure) {
    super(`Paystack request ${failure}`);
    this.name = "PaystackError";
  }
}

export type PaystackBank = { code: string; name: string };

/** For pages deciding what to offer; a malformed key counts as not configured (and is logged). */
export function isPaystackConfigured(): boolean {
  try {
    return getPaystackConfig() !== null;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[paystack] configuration error: ${error.message}`);
    return false;
  }
}

function requireConfig(): PaystackConfig {
  const config = getPaystackConfig();
  if (!config) throw new PaystackError("misconfigured");
  return config;
}

export type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

async function paystack(operation: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: Json | null }> {
  const { secretKey } = requireConfig();
  let res: Response;
  try {
    res = await fetch(`${PAYSTACK_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    console.error(`[paystack] ${operation} failed: ${error instanceof Error ? error.name : "unknown"}`);
    throw new PaystackError("unavailable");
  }
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    console.error(`[paystack] ${operation}: the secret key was refused (HTTP ${res.status})`);
    throw new PaystackError("misconfigured");
  }
  return { status: res.status, body: isObject(body) ? body : null };
}

/** A 4xx answer where Paystack explicitly said no, as opposed to an outage. */
function isRejection(status: number, body: Json | null) {
  return status >= 400 && status < 500 && status !== 429 && body?.status === false;
}

function unexpected(operation: string, status: number): PaystackError {
  console.error(`[paystack] ${operation}: unexpected response (HTTP ${status})`);
  return new PaystackError("unavailable");
}

// --- bank list -------------------------------------------------------------

const BANK_CODE = /^[A-Za-z0-9]{2,20}$/;
const BANK_LIST_TTL_MS = 6 * 60 * 60_000;
const MAX_BANK_PAGES = 10;

let bankCache: { banks: PaystackBank[]; expiresAt: number } | null = null;
let bankRequest: Promise<PaystackBank[]> | null = null;

/** Tests only: forget the cached bank list. */
export function clearBankListCache() {
  bankCache = null;
  bankRequest = null;
}

function toBank(item: unknown): PaystackBank | null {
  if (!isObject(item)) return null;
  const { name, code } = item;
  if (typeof name !== "string" || typeof code !== "string") return null;
  const cleanName = name.trim().replace(/\s+/g, " ");
  if (!cleanName || cleanName.length > 120 || !BANK_CODE.test(code)) return null;
  // only live NUBAN banks that can receive transfers
  if (item.active === false || item.is_deleted === true || item.supports_transfer === false) return null;
  if (item.type !== undefined && item.type !== "nuban") return null;
  if (item.currency !== undefined && item.currency !== "NGN") return null;
  return { code, name: cleanName };
}

async function fetchBanks(): Promise<PaystackBank[]> {
  const byCode = new Map<string, PaystackBank>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_BANK_PAGES; page++) {
    const query = new URLSearchParams({ country: "nigeria", currency: "NGN", use_cursor: "true", perPage: "100" });
    if (cursor) query.set("next", cursor);
    const { status, body } = await paystack("bank list", `/bank?${query}`);
    if (status !== 200 || body?.status !== true || !Array.isArray(body.data)) throw unexpected("bank list", status);
    for (const bank of body.data.map(toBank)) if (bank && !byCode.has(bank.code)) byCode.set(bank.code, bank);
    const next = isObject(body.meta) ? body.meta.next : null;
    cursor = typeof next === "string" && next ? next : null;
    if (!cursor) break;
  }
  const banks = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (banks.length === 0) throw unexpected("bank list (empty)", 200);
  return banks;
}

/**
 * Nigerian banks that can receive transfers, sorted by name. The list is
 * the same for everyone and rarely changes, so each server instance keeps
 * it for a few hours (failures are never cached).
 */
export async function listBanks(): Promise<PaystackBank[]> {
  if (bankCache && bankCache.expiresAt > Date.now()) return bankCache.banks;
  bankRequest ??= fetchBanks()
    .then((banks) => {
      bankCache = { banks, expiresAt: Date.now() + BANK_LIST_TTL_MS };
      return banks;
    })
    .finally(() => {
      bankRequest = null;
    });
  return bankRequest;
}

// --- account resolution ----------------------------------------------------

export type ResolvedAccount = { accountName: string; accountNumber: string };

/**
 * Asks Paystack for the name registered to an account. Never cached: every
 * check is a fresh request.
 */
export async function resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
  const query = new URLSearchParams({ account_number: accountNumber, bank_code: bankCode });
  const { status, body } = await paystack("account resolution", `/bank/resolve?${query}`);
  if (isRejection(status, body)) throw new PaystackError("rejected");
  if (status !== 200 || body?.status !== true || !isObject(body.data)) throw unexpected("account resolution", status);

  const name = body.data.account_name;
  const number = body.data.account_number;
  const accountName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!accountName || accountName.length > 120 || number !== accountNumber)
    throw unexpected("account resolution (malformed)", status);
  return { accountName, accountNumber };
}

// --- transfer recipients ---------------------------------------------------

export type NewRecipient = {
  accountName: string;
  accountNumber: string;
  bankCode: string;
  /** our own reference, to match recipients to records when reconciling */
  reference: string;
};

const RECIPIENT_CODE = /^RCP_[A-Za-z0-9]+$/;

/**
 * Creates a NUBAN transfer recipient and returns its code. Paystack returns
 * the existing recipient for an account number it already has, so retrying
 * after a failure doesn't create duplicates.
 */
export async function createTransferRecipient(input: NewRecipient): Promise<{ recipientCode: string }> {
  const { status, body } = await paystack("recipient creation", "/transferrecipient", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "nuban",
      name: input.accountName,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: "NGN",
      metadata: { farm_korret_ref: input.reference },
    }),
  });
  if (isRejection(status, body)) throw new PaystackError("rejected");
  if ((status !== 200 && status !== 201) || body?.status !== true || !isObject(body.data))
    throw unexpected("recipient creation", status);

  const data = body.data;
  const details = isObject(data.details) ? data.details : {};
  const code = data.recipient_code;
  const matches =
    typeof code === "string" &&
    RECIPIENT_CODE.test(code) &&
    data.active !== false &&
    (data.currency === undefined || data.currency === "NGN") &&
    (details.account_number === undefined || details.account_number === input.accountNumber) &&
    (details.bank_code === undefined || details.bank_code === input.bankCode);
  if (!matches) throw unexpected("recipient creation (malformed)", status);
  return { recipientCode: code };
}

// --- transfers ---------------------------------------------------------------

/** What a Paystack transfer status means for a payout. */
export type TransferOutcome = "paid" | "failed" | "pending";

const TRANSFER_OUTCOMES: Record<string, TransferOutcome> = {
  success: "paid",
  failed: "failed",
  reversed: "failed",
  abandoned: "failed",
  blocked: "failed",
  rejected: "failed",
  pending: "pending",
  received: "pending",
  queued: "pending",
  processing: "pending",
  // needs an OTP: transfer OTP must be disabled for API payouts
  otp: "pending",
};

/** null for a status we don't know: treated as "not settled yet". */
export function transferOutcome(status: string): TransferOutcome | null {
  return Object.hasOwn(TRANSFER_OUTCOMES, status) ? TRANSFER_OUTCOMES[status] : null;
}

export type TransferResult = {
  status: string;
  reference: string;
  amountKobo: number;
  transferCode: string | null;
  recipientCode: string | null;
};

const TRANSFER_CODE = /^TRF_[A-Za-z0-9]+$/;

/** Validates the transfer object in a Paystack response or webhook. */
export function parseTransfer(data: Json): TransferResult | null {
  const { status, reference, amount, currency, transfer_code: code } = data;
  const recipient = isObject(data.recipient) ? data.recipient.recipient_code : data.recipient;
  if (typeof status !== "string" || !/^[a-z_]{1,30}$/.test(status)) return null;
  if (typeof reference !== "string" || typeof amount !== "number" || !Number.isSafeInteger(amount)) return null;
  if (currency !== undefined && currency !== "NGN") return null;
  if (code !== undefined && code !== null && (typeof code !== "string" || !TRANSFER_CODE.test(code))) return null;
  return {
    status,
    reference,
    amountKobo: amount,
    transferCode: typeof code === "string" ? code : null,
    recipientCode: typeof recipient === "string" && RECIPIENT_CODE.test(recipient) ? recipient : null,
  };
}

export type NewTransfer = { amountKobo: number; recipientCode: string; reference: string; reason: string };

/**
 * Sends money from the Paystack balance to a saved recipient. Our reference
 * identifies the transfer from then on; callers must never send the same
 * payout twice (reconcile with verifyTransfer instead).
 *
 * - PaystackError "rejected": Paystack refused it (no transfer was made)
 * - PaystackError "unavailable": the outcome is unknown and must be checked
 *   later with verifyTransfer
 */
export async function initiateTransfer(input: NewTransfer): Promise<TransferResult> {
  const { status, body } = await paystack("transfer", "/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "balance",
      amount: input.amountKobo,
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason,
      currency: "NGN",
    }),
  });
  if (isRejection(status, body)) throw new PaystackError("rejected");
  if (status !== 200 || body?.status !== true || !isObject(body.data)) throw unexpected("transfer", status);
  const transfer = parseTransfer(body.data);
  if (!transfer || transfer.reference !== input.reference || transfer.amountKobo !== input.amountKobo)
    throw unexpected("transfer (malformed)", status);
  return transfer;
}

/** The transfer with our reference, or null if Paystack has none. */
export async function verifyTransfer(reference: string): Promise<TransferResult | null> {
  const { status, body } = await paystack("transfer verification", `/transfer/verify/${encodeURIComponent(reference)}`);
  if (status === 404 || (status === 400 && body?.status === false)) return null;
  if (status !== 200 || body?.status !== true || !isObject(body.data)) throw unexpected("transfer verification", status);
  const transfer = parseTransfer(body.data);
  if (!transfer || transfer.reference !== reference) throw unexpected("transfer verification (malformed)", status);
  return transfer;
}

// --- collecting payments ---------------------------------------------------------

/** What a Paystack transaction status means for an order payment. */
export type TransactionOutcome = "success" | "failed" | "pending";

const TRANSACTION_OUTCOMES: Record<string, TransactionOutcome> = {
  success: "success",
  failed: "failed",
  reversed: "failed",
  // the checkout page was opened but not completed: it can still be paid
  abandoned: "pending",
  ongoing: "pending",
  pending: "pending",
  processing: "pending",
  queued: "pending",
};

/** An unknown status is never treated as paid or failed. */
export function transactionOutcome(status: string): TransactionOutcome {
  return Object.hasOwn(TRANSACTION_OUTCOMES, status) ? TRANSACTION_OUTCOMES[status] : "pending";
}

export type NewTransaction = {
  email: string;
  amountKobo: number;
  /** our reference (fko_…), stable for this payment attempt */
  reference: string;
  callbackUrl: string;
  /** our order id and number, echoed back by verification */
  orderId: string;
  orderNumber: string;
};

/** Only Paystack's own checkout pages are ever handed to the browser. */
function isCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paystack.com" || url.hostname.endsWith(".paystack.com"));
  } catch {
    return false;
  }
}

/**
 * Starts a payment and returns the checkout page for the buyer. Nothing is
 * charged until the buyer completes that page, and completion is only ever
 * confirmed with verifyTransaction.
 *
 * - PaystackError "rejected": Paystack refused it (no transaction exists)
 * - PaystackError "unavailable": it may or may not exist; check with
 *   verifyTransaction before starting another
 */
export async function initializeTransaction(input: NewTransaction): Promise<{ authorizationUrl: string }> {
  const { status, body } = await paystack("transaction initialization", "/transaction/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      amount: input.amountKobo,
      currency: "NGN",
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: { order_id: input.orderId, order_number: input.orderNumber },
    }),
  });
  if (isRejection(status, body)) throw new PaystackError("rejected");
  if (status !== 200 || body?.status !== true || !isObject(body.data)) throw unexpected("transaction initialization", status);
  const { authorization_url: url, reference } = body.data;
  if (!isCheckoutUrl(url) || reference !== input.reference) throw unexpected("transaction initialization (malformed)", status);
  return { authorizationUrl: url };
}

export type TransactionResult = {
  status: string;
  reference: string;
  amountKobo: number;
  currency: string;
  transactionId: number | null;
  paidAt: Date | null;
  /** the order id we sent in the metadata, if it came back */
  orderId: string | null;
};

function parseMetadata(value: unknown): Json | null {
  if (isObject(value)) return value;
  // Paystack sometimes returns metadata as a JSON string
  if (typeof value === "string" && value.length < 4_000) {
    try {
      const parsed: unknown = JSON.parse(value);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Validates the transaction object in a verification response. */
export function parseTransaction(data: Json): TransactionResult | null {
  const { status, reference, amount, currency, id } = data;
  if (typeof status !== "string" || !/^[a-z_]{1,30}$/.test(status)) return null;
  if (typeof reference !== "string" || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  const paidAt = typeof data.paid_at === "string" ? new Date(data.paid_at) : null;
  const orderId = parseMetadata(data.metadata)?.order_id;
  return {
    status,
    reference,
    amountKobo: amount,
    currency,
    transactionId: typeof id === "number" && Number.isSafeInteger(id) ? id : null,
    paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
    orderId: typeof orderId === "string" ? orderId : null,
  };
}

/** The transaction with our reference, or null if Paystack has none. */
export async function verifyTransaction(reference: string): Promise<TransactionResult | null> {
  const { status, body } = await paystack(
    "transaction verification",
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
  if (status === 404 || (status === 400 && body?.status === false)) return null;
  if (status !== 200 || body?.status !== true || !isObject(body.data)) throw unexpected("transaction verification", status);
  const transaction = parseTransaction(body.data);
  if (!transaction || transaction.reference !== reference) throw unexpected("transaction verification (malformed)", status);
  return transaction;
}

// --- refunds ---------------------------------------------------------------------

export type RefundOutcome = "processed" | "failed" | "pending";

/** Anything but Paystack's final "processed" or "failed" is still in progress. */
export function refundOutcome(status: string): RefundOutcome {
  if (status === "processed") return "processed";
  if (status === "failed") return "failed";
  return "pending";
}

export type RefundResult = {
  id: number;
  status: string;
  amountKobo: number;
  /** the refunded transaction's Paystack id, when given */
  transactionId: number | null;
};

function parseRefund(data: Json): RefundResult | null {
  const { id, status, amount, currency } = data;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof status !== "string" || !/^[a-z_-]{1,30}$/.test(status)) return null;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (currency !== undefined && currency !== "NGN") return null;
  const transaction = isObject(data.transaction) ? data.transaction.id : data.transaction;
  return {
    id,
    status,
    amountKobo: amount,
    transactionId: typeof transaction === "number" && Number.isSafeInteger(transaction) ? transaction : null,
  };
}

/**
 * Returns part or all of a successful payment to the buyer. Paystack doesn't
 * take our own reference for a refund, so callers must not send another
 * one for the same request until this one is found (see listRefunds).
 *
 * - PaystackError "rejected": Paystack refused it (no refund was made)
 * - PaystackError "unavailable": the outcome is unknown
 */
export async function createRefund(input: {
  transactionReference: string;
  amountKobo: number;
  note: string;
}): Promise<RefundResult> {
  const { status, body } = await paystack("refund", "/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction: input.transactionReference,
      amount: input.amountKobo,
      currency: "NGN",
      merchant_note: input.note,
    }),
  });
  if (isRejection(status, body)) throw new PaystackError("rejected");
  if ((status !== 200 && status !== 201) || body?.status !== true || !isObject(body.data)) throw unexpected("refund", status);
  const refund = parseRefund(body.data);
  if (!refund || refund.amountKobo !== input.amountKobo) throw unexpected("refund (malformed)", status);
  return refund;
}

/** One refund by its Paystack id, or null if Paystack has none. */
export async function fetchRefund(id: number): Promise<RefundResult | null> {
  const { status, body } = await paystack("refund lookup", `/refund/${id}`);
  if (status === 404 || (status === 400 && body?.status === false)) return null;
  if (status !== 200 || body?.status !== true || !isObject(body.data)) throw unexpected("refund lookup", status);
  const refund = parseRefund(body.data);
  if (!refund || refund.id !== id) throw unexpected("refund lookup (malformed)", status);
  return refund;
}

/** The refunds Paystack has for one transaction (by its Paystack id). */
export async function listRefunds(transactionId: number): Promise<RefundResult[]> {
  const query = new URLSearchParams({ transaction: String(transactionId), perPage: "100" });
  const { status, body } = await paystack("refund list", `/refund?${query}`);
  if (status !== 200 || body?.status !== true || !Array.isArray(body.data)) throw unexpected("refund list", status);
  const refunds: RefundResult[] = [];
  for (const item of body.data) {
    const refund = isObject(item) ? parseRefund(item) : null;
    if (!refund) throw unexpected("refund list (malformed)", status);
    // only this transaction's refunds count, whatever the filter returned
    if (refund.transactionId === transactionId) refunds.push(refund);
  }
  return refunds;
}

// --- webhooks ------------------------------------------------------------------

/**
 * Whether `signature` (the x-paystack-signature header) is Paystack's
 * HMAC-SHA512 of exactly these raw bytes, keyed with our secret key.
 */
export function isValidWebhookSignature(rawBody: Buffer, signature: string | null): boolean {
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const { secretKey } = requireConfig();
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
