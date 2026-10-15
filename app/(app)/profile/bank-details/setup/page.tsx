import type { Metadata } from "next";
import { BankAccountForm } from "@/components/bank-details/bank-account-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findCurrentAccount, toSummary } from "@/lib/server/payout-accounts";

export const metadata: Metadata = { title: "Bank Account" };

// Adds the first payout account, or replaces the current one. Which of the
// two comes from the database, never from the URL; the API checks again.
export default async function BankAccountSetupPage() {
  const { user } = await requireVerifiedPageSession();
  const current = await findCurrentAccount(user._id);
  return <BankAccountForm current={current ? toSummary(current) : null} />;
}
