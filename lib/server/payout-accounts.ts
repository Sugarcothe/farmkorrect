import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import type { BankAccountSummary, BankVerification, ConfirmRequest, ResolveRequest } from "@/lib/bank-details/types";
import { validateAccountNumber, validateBankCode } from "@/lib/bank-details/validation";
import { getAuthConfig } from "./config";
import { hashToken, hmac, randomToken, safeEqualHex } from "./crypto";
import { getDb, getMongoClient } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type BankVerificationDoc, type PayoutAccountDoc } from "./models";
import { createTransferRecipient, listBanks, PaystackError, resolveAccount, type PaystackBank } from "./paystack";

// Bank details for payouts, in two server-side steps:
//
// 1. check (resolve): the account number and bank are sent to Paystack, which
//    returns the registered account name. A single-use, ten-minute
//    verification is stored for this user, and the browser gets a random
//    token for it — never the details themselves.
// 2. confirm: the browser sends the token with the same bank and number. The
//    server checks they match the verification, creates a Paystack transfer
//    recipient with the name *Paystack* returned, and only then makes it the
//    user's current account, in one transaction that retires the old one.
//
// The owner always comes from the session. Full account numbers are never
// stored or returned; recipient codes are stored but never returned.

export const BANK_DETAILS_UNVERIFIED = "Verify your phone number before adding bank details.";
export const VERIFICATION_TTL_MS = 10 * 60_000;
/** a confirmation that crashed mid-way stops blocking retries after this */
const CLAIM_TIMEOUT_MS = 60_000;

const UNAVAILABLE = "Bank verification isn't available right now. Please try again later.";
const UNREACHABLE = "We couldn't reach our payment partner, Paystack. Please try again in a moment.";
const VERIFICATION_EXPIRED =
  "This check has expired or was already used. Check the account again to continue.";

async function payoutAccounts() {
  return (await getDb()).collection<PayoutAccountDoc>(COLLECTIONS.payoutAccounts);
}
async function verifications() {
  return (await getDb()).collection<BankVerificationDoc>(COLLECTIONS.bankVerifications);
}

function fingerprint(bankCode: string, accountNumber: string): string {
  return hmac(getAuthConfig().secret, "bank-account", bankCode, accountNumber);
}

/** Turns a Paystack failure into a safe response; `rejected` says what to do next. */
function paystackFailure(error: unknown, rejected: HttpError): never {
  if (!(error instanceof PaystackError)) throw error;
  if (error.failure === "rejected") throw rejected;
  if (error.failure === "misconfigured") throw new HttpError(503, UNAVAILABLE);
  throw new HttpError(502, UNREACHABLE);
}

// --- request parsing -------------------------------------------------------

function parseFields<K extends string>(body: Record<string, unknown>, allowed: readonly K[]): Record<K, string> {
  const fieldErrors: Record<string, string> = {};
  // refuse anything else (account names, statuses, recipient codes, owner ids…)
  // rather than quietly ignoring it
  for (const key of Object.keys(body))
    if (!(allowed as readonly string[]).includes(key)) fieldErrors[key] = "This field can't be set.";
  const values = {} as Record<K, string>;
  for (const key of allowed) {
    const value = body[key];
    if (value !== undefined && typeof value !== "string") fieldErrors[key] = "This field must be text.";
    values[key] = typeof value === "string" ? value : "";
  }
  if (Object.keys(fieldErrors).length)
    throw new HttpError(400, "Some details aren't valid. Check the highlighted fields.", fieldErrors);
  return values;
}

function checkAccountFields(values: ResolveRequest) {
  const fieldErrors: Record<string, string> = {};
  const bank = validateBankCode(values.bankCode);
  const number = validateAccountNumber(values.accountNumber);
  if (bank) fieldErrors.bankCode = bank;
  if (number) fieldErrors.accountNumber = number;
  if (Object.keys(fieldErrors).length)
    throw new HttpError(400, "Some details aren't valid. Check the highlighted fields.", fieldErrors);
}

export function parseResolveRequest(body: Record<string, unknown>): ResolveRequest {
  const values = parseFields(body, ["bankCode", "accountNumber"] as const);
  checkAccountFields(values);
  return values;
}

export function parseConfirmRequest(body: Record<string, unknown>): ConfirmRequest {
  const values = parseFields(body, ["verificationId", "bankCode", "accountNumber"] as const);
  checkAccountFields(values);
  if (!/^[A-Za-z0-9_-]{43}$/.test(values.verificationId)) throw verificationExpired();
  return values;
}

function verificationExpired() {
  return new HttpError(400, VERIFICATION_EXPIRED, { verificationId: VERIFICATION_EXPIRED });
}

// --- reading ---------------------------------------------------------------

export function toSummary(doc: PayoutAccountDoc): BankAccountSummary {
  return {
    bankName: doc.bankName,
    accountName: doc.accountName,
    accountNumberLast4: doc.accountNumberLast4,
    status: doc.status,
    readyForPayouts: doc.status === "recipient_created" && doc.recipientCode !== null,
    verifiedAt: doc.recipientCreatedAt?.toISOString() ?? null,
  };
}

export async function findCurrentAccount(ownerUserId: ObjectId): Promise<PayoutAccountDoc | null> {
  return (await payoutAccounts()).findOne({ ownerUserId, current: true });
}

/** The supported banks, or a safe error when Paystack can't provide them. */
export async function supportedBanks(): Promise<PaystackBank[]> {
  try {
    return await listBanks();
  } catch (error) {
    paystackFailure(error, new HttpError(502, UNREACHABLE));
  }
}

// --- step 1: check ---------------------------------------------------------

export async function checkAccount(userId: ObjectId, input: ResolveRequest): Promise<BankVerification> {
  const bank = (await supportedBanks()).find((b) => b.code === input.bankCode);
  if (!bank)
    throw new HttpError(400, "Choose a bank from the list.", { bankCode: "Choose a bank from the list." });

  // a new check always replaces the previous one, whatever its details
  const collection = await verifications();
  const now = new Date();
  await collection.updateMany({ userId, active: true }, { $set: { active: false, supersededAt: now } });

  let resolved;
  try {
    resolved = await resolveAccount(input.accountNumber, bank.code);
  } catch (error) {
    const message = `We couldn't find this account number at ${bank.name}. Check the number and the bank, then try again.`;
    paystackFailure(error, new HttpError(422, message, { accountNumber: message }));
  }

  const token = randomToken();
  const doc: BankVerificationDoc = {
    _id: new ObjectId(),
    userId,
    tokenHash: hashToken(token),
    bankCode: bank.code,
    bankName: bank.name,
    accountFingerprint: fingerprint(bank.code, resolved.accountNumber),
    accountNumberLast4: resolved.accountNumber.slice(-4),
    accountName: resolved.accountName,
    active: true,
    createdAt: now,
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    claimedAt: null,
    consumedAt: null,
    supersededAt: null,
  };
  try {
    await collection.insertOne(doc);
  } catch (error) {
    // another check for this user landed at the same moment
    if (error instanceof MongoServerError && error.code === 11000)
      throw new HttpError(409, "Another check is already in progress. Please try again.");
    throw error;
  }
  return {
    id: token,
    bankCode: doc.bankCode,
    bankName: doc.bankName,
    accountName: doc.accountName,
    accountNumberLast4: doc.accountNumberLast4,
    expiresAt: doc.expiresAt.toISOString(),
  };
}

// --- step 2: confirm -------------------------------------------------------

export type ConfirmMode = "add" | "replace";

/** Releases a claimed verification so the user can try confirming again. */
async function release(verificationId: ObjectId) {
  await (await verifications())
    .updateOne({ _id: verificationId, consumedAt: null }, { $set: { claimedAt: null } })
    .catch(() => {});
}

export async function confirmAccount(
  userId: ObjectId,
  mode: ConfirmMode,
  input: ConfirmRequest,
): Promise<BankAccountSummary> {
  const verificationCollection = await verifications();
  const accounts = await payoutAccounts();
  const now = new Date();

  // the token only works for the account it was issued to
  const verification = await verificationCollection.findOne({ tokenHash: hashToken(input.verificationId), userId });
  if (!verification || !verification.active || verification.consumedAt || verification.expiresAt <= now)
    throw verificationExpired();

  // the confirmed details must be exactly the ones that were checked
  if (
    verification.bankCode !== input.bankCode ||
    !safeEqualHex(verification.accountFingerprint, fingerprint(input.bankCode, input.accountNumber))
  ) {
    await verificationCollection.updateOne(
      { _id: verification._id, active: true },
      { $set: { active: false, supersededAt: now } },
    );
    const message = "These details don't match the account you checked. Check the account again to continue.";
    throw new HttpError(400, message, { verificationId: message });
  }

  const current = await findCurrentAccount(userId);
  if (mode === "add" && current)
    throw new HttpError(409, "You already have a bank account saved. Use Change Bank Account to replace it.");
  if (mode === "replace" && !current) throw new HttpError(404, "There's no saved bank account to replace.");

  // claim it, so a double-submit can't run the rest twice
  const claimed = await verificationCollection.findOneAndUpdate(
    {
      _id: verification._id,
      active: true,
      consumedAt: null,
      expiresAt: { $gt: now },
      $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } }],
    },
    { $set: { claimedAt: now } },
  );
  if (!claimed) throw new HttpError(409, "This account is already being saved. Please wait a moment.");

  // the attempt is recorded before Paystack is called, as "resolved"
  const attempt: PayoutAccountDoc = {
    _id: new ObjectId(),
    ownerUserId: userId,
    bankCode: verification.bankCode,
    bankName: verification.bankName,
    accountNumberLast4: verification.accountNumberLast4,
    accountFingerprint: verification.accountFingerprint,
    accountName: verification.accountName,
    status: "resolved",
    recipientCode: null,
    current: false,
    resolvedAt: verification.createdAt,
    recipientCreatedAt: null,
    failedAt: null,
    replacedAt: null,
    replacedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await accounts.insertOne(attempt);
  } catch (error) {
    await release(verification._id);
    throw error;
  }

  let recipientCode: string;
  try {
    ({ recipientCode } = await createTransferRecipient({
      accountName: verification.accountName,
      accountNumber: input.accountNumber,
      bankCode: verification.bankCode,
      reference: attempt._id.toHexString(),
    }));
  } catch (error) {
    const failedAt = new Date();
    await accounts
      .updateOne({ _id: attempt._id }, { $set: { status: "failed", failedAt, updatedAt: failedAt } })
      .catch(() => {});
    await release(verification._id);
    paystackFailure(
      error,
      new HttpError(
        422,
        "Paystack couldn't set up this account for payouts. Check the details, or try a different account.",
      ),
    );
  }

  // make it the current account (retiring the old one) in one transaction:
  // either everything below happens or nothing does
  const savedAt = new Date();
  const client = await getMongoClient();
  try {
    await client.withSession((dbSession) =>
      dbSession.withTransaction(async () => {
        if (current) {
          const retired = await accounts.updateOne(
            { _id: current._id, ownerUserId: userId, current: true },
            { $set: { current: false, replacedAt: savedAt, replacedBy: attempt._id, updatedAt: savedAt } },
            { session: dbSession },
          );
          if (retired.modifiedCount !== 1)
            throw new HttpError(409, "Your bank details changed in the meantime. Reload the page and try again.");
        }
        await accounts.updateOne(
          { _id: attempt._id },
          {
            $set: {
              status: "recipient_created",
              recipientCode,
              recipientCreatedAt: savedAt,
              current: true,
              updatedAt: savedAt,
            },
          },
          { session: dbSession },
        );
        const used = await verificationCollection.updateOne(
          { _id: verification._id, active: true, consumedAt: null },
          { $set: { active: false, consumedAt: savedAt } },
          { session: dbSession },
        );
        if (used.modifiedCount !== 1) throw verificationExpired();
      }),
    );
  } catch (error) {
    // Paystack has the recipient, but it isn't saved as the user's account.
    // Keep the code on the (non-current) attempt for reconciliation if the
    // database allows it; a retry gets the same recipient back from
    // Paystack, so no duplicate is created.
    await accounts
      .updateOne(
        { _id: attempt._id, current: false },
        { $set: { status: "recipient_created", recipientCode, recipientCreatedAt: savedAt, updatedAt: savedAt } },
      )
      .catch(() => {});
    await release(verification._id);
    if (error instanceof HttpError) throw error;
    if (error instanceof MongoServerError && error.code === 11000)
      throw new HttpError(409, "You already have a bank account saved. Reload the page to see it.");
    const name = error instanceof Error ? error.name : "unknown";
    console.error(`[bank-details] saving the account failed after recipient creation: ${name}`);
    throw new HttpError(
      500,
      mode === "replace"
        ? "We couldn't save the new account. Your current bank account hasn't changed. Please try again."
        : "We couldn't save your bank account. Nothing was saved. Please try again.",
    );
  }

  return toSummary({
    ...attempt,
    status: "recipient_created",
    recipientCode,
    recipientCreatedAt: savedAt,
    current: true,
    updatedAt: savedAt,
  });
}
