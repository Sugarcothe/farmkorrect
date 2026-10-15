import { ObjectId } from "mongodb";
import { expect } from "vitest";
import { POST as addAccount } from "@/app/api/bank-details/route";
import { POST as resolveRoute } from "@/app/api/bank-details/resolve/route";
import type { ResolveResponse } from "@/lib/bank-details/types";
import { getWalletSummary, recordDelivery, recordEarning } from "@/lib/server/ledger";
import { userByPhone } from "./db";
import { newRegistration, registerVerified } from "./flows";
import { call, dataOf } from "./http";

// Helpers for wallet and payout tests. Earnings are recorded through the
// server-side ledger functions (the boundary future order/payment modules
// will call), never by writing entries directly.

export const HOUR = 60 * 60_000;
export const ZENITH = { bankCode: "057", accountNumber: "0123456789" };
export const ACCESS = { bankCode: "044", accountNumber: "1234567890" };

/** A verified account; returns its cookie and user id. */
export async function merchant(role: "poultry-farmer" | "veterinarian" = "veterinarian") {
  const { input, cookie } = await registerVerified(newRegistration({ role }));
  const user = await userByPhone(input.phone);
  return { cookie, userId: user!._id };
}

/** Saves a verified Paystack payout account through the Bank Details API. */
export async function addBankAccount(cookie: string, account = ZENITH, add = addAccount) {
  const resolved = await call<ResolveResponse>(resolveRoute, "/api/bank-details/resolve", { body: account, cookie });
  const { verification } = dataOf(resolved);
  const res = await call(add, "/api/bank-details", {
    body: { verificationId: verification.id, ...account },
    cookie,
    method: add === addAccount ? "POST" : "PATCH",
  });
  expect(res.status).toBeLessThan(300);
}

let orders = 0;

/**
 * A paid order for the merchant; delivered `deliveredHoursAgo` hours ago
 * (null: not delivered yet).
 */
export async function paidOrder(
  userId: ObjectId,
  options: { grossKobo?: number; feeKobo?: number; deliveredHoursAgo?: number | null; id?: string } = {},
) {
  orders += 1;
  const sourceId = options.id ?? `ord_${orders}_${new ObjectId().toHexString().slice(-6)}`;
  await recordEarning({
    merchantUserId: userId,
    sourceType: "order",
    sourceId,
    paymentReference: `pay_${sourceId}`,
    grossKobo: options.grossKobo ?? 10_000_00,
    platformFeeKobo: options.feeKobo ?? 0,
    currency: "NGN",
  });
  const hours = options.deliveredHoursAgo === undefined ? 25 : options.deliveredHoursAgo;
  if (hours !== null)
    await recordDelivery({ sourceType: "order", sourceId, deliveredAt: new Date(Date.now() - hours * HOUR) });
  return sourceId;
}

export const summaryOf = (userId: ObjectId) => getWalletSummary(userId);
