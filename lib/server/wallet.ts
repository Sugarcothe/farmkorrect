import "server-only";
import type { ObjectId } from "mongodb";
import type { TransactionFilter, WalletResponse } from "@/lib/wallet/types";
import { HttpError } from "./http";
import { getWalletSummary, isTransactionFilter, listTransactions } from "./ledger";
import { payoutDestination, payoutsEnabled } from "./payouts";

// What the Wallet screens and /api/wallet* read. Everything is derived from
// the ledger for the user in the session.

export const WALLET_UNVERIFIED = "Verify your phone number to use your wallet.";
export const RECENT_COUNT = 5;
export const PAGE_SIZE = 20;

export async function getWalletOverview(userId: ObjectId): Promise<WalletResponse> {
  const summary = await getWalletSummary(userId);
  const recent = await listTransactions(userId, { filter: "all", before: null, limit: RECENT_COUNT });
  const destination = await payoutDestination(userId);
  return { summary, recent: recent.transactions, destination, payoutsEnabled: payoutsEnabled() };
}

const invalid = (field: string, message: string) => new HttpError(400, message, { [field]: message });

/** ?filter=&before=&limit= for the transaction history. */
export function parseTransactionQuery(params: URLSearchParams): {
  filter: TransactionFilter;
  before: number | null;
  limit: number;
} {
  const filter = params.get("filter") ?? "all";
  if (!isTransactionFilter(filter)) throw invalid("filter", "Unknown filter.");
  const before = params.get("before");
  if (before !== null && !/^[1-9]\d{0,11}$/.test(before)) throw invalid("before", "Invalid page cursor.");
  const limit = params.get("limit");
  if (limit !== null && !/^([1-9]|[1-4]\d|50)$/.test(limit)) throw invalid("limit", "limit must be 1 to 50.");
  return { filter, before: before === null ? null : Number(before), limit: limit === null ? PAGE_SIZE : Number(limit) };
}

/** ?page= (1-based) for paged lists. */
export function parsePage(params: URLSearchParams): number {
  const page = params.get("page");
  if (page === null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(page)) throw invalid("page", "Invalid page.");
  return Number(page);
}
