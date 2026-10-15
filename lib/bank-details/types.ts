// Shapes the Bank Details API sends and accepts. Full account numbers and
// Paystack recipient codes never appear in a response.

export type Bank = { code: string; name: string };

/**
 * Where a payout account is in the setup workflow:
 * - "resolved": Paystack confirmed the account name, but no transfer
 *   recipient has been recorded yet
 * - "recipient_created": a Paystack transfer recipient exists and is saved,
 *   so the account is ready for future payouts
 * - "failed": recipient creation failed; the attempt was never used
 */
export type PayoutAccountStatus = "resolved" | "recipient_created" | "failed";

export type BankAccountSummary = {
  bankName: string;
  /** the name Paystack returned for the account */
  accountName: string;
  accountNumberLast4: string;
  status: PayoutAccountStatus;
  readyForPayouts: boolean;
  /** when the account was confirmed and its recipient created (ISO 8601) */
  verifiedAt: string | null;
};

/** A checked account waiting for the user to confirm it. */
export type BankVerification = {
  /** single-use, short-lived reference to the check held on the server */
  id: string;
  bankCode: string;
  bankName: string;
  accountName: string;
  accountNumberLast4: string;
  expiresAt: string;
};

export type BanksResponse = { banks: Bank[] };
export type BankAccountResponse = { account: BankAccountSummary | null };
export type ResolveRequest = { bankCode: string; accountNumber: string };
export type ResolveResponse = { verification: BankVerification };
export type ConfirmRequest = ResolveRequest & { verificationId: string };
export type ConfirmResponse = { account: BankAccountSummary };
