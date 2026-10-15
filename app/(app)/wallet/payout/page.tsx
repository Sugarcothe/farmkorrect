import type { Metadata } from "next";
import Link from "next/link";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { PayoutForm } from "@/components/wallet/payout-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getWalletSummary } from "@/lib/server/ledger";
import { NO_PAYOUT_ACCOUNT, PAYOUTS_OFF, payoutDestination, payoutsEnabled } from "@/lib/server/payouts";
import { formatKobo } from "@/lib/wallet/money";
import { MIN_PAYOUT_KOBO } from "@/lib/wallet/types";

export const metadata: Metadata = { title: "Request Payout" };

// The amount shown here is only a guide for the form: the server checks the
// balance again, under a lock, when the request is submitted.
export default async function RequestPayoutPage() {
  const { user } = await requireVerifiedPageSession();
  const [summary, destination] = await Promise.all([getWalletSummary(user._id), payoutDestination(user._id)]);
  const enabled = payoutsEnabled();

  let blocker: { title: string; text: string; action?: { href: string; label: string } } | null = null;
  if (!enabled) blocker = { title: "Payouts aren't open yet", text: PAYOUTS_OFF };
  else if (!destination)
    blocker = {
      title: "Add a bank account first",
      text: NO_PAYOUT_ACCOUNT,
      action: { href: "/profile/bank-details", label: "Go to Bank Details" },
    };
  else if (summary.availableKobo < MIN_PAYOUT_KOBO)
    blocker = {
      title: "Not enough available yet",
      text: `You have ${formatKobo(summary.availableKobo)} available. The smallest payout is ${formatKobo(MIN_PAYOUT_KOBO)}. Earnings become available 24 hours after delivery.`,
    };

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Request Payout" back={<BackLink href="/wallet" />} />
      {blocker || !destination ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/8 text-primary">
            <Icon name="landmark" className="size-8" />
          </div>
          <h2 className="mt-5 text-xl font-semibold tracking-tight">{blocker?.title}</h2>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{blocker?.text}</p>
          {blocker?.action && (
            <Link href={blocker.action.href} className={buttonClasses("solid", "mt-8 max-w-xs")}>
              {blocker.action.label}
            </Link>
          )}
          <Link href="/wallet" className={buttonClasses("ghost", "mt-2 max-w-xs")}>
            Back to Wallet
          </Link>
        </div>
      ) : (
        <PayoutForm availableKobo={summary.availableKobo} destination={destination} />
      )}
    </main>
  );
}
