import "server-only";
import { ConfigError, getPaystackConfig, type PaystackConfig } from "./config";

// A small client for the three Paystack calls bank details need: the bank
// list, account-name resolution and transfer-recipient creation. Requests
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

type Json = Record<string, unknown>;
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
