import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icons";
import { EmptyList, first, formatDate, ListCard, TransactionRow } from "@/components/wallet/wallet-parts";
import { maskAccountNumber } from "@/lib/bank-details/validation";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getWalletOverview } from "@/lib/server/wallet";
import { formatKobo } from "@/lib/wallet/money";
import { MIN_PAYOUT_KOBO } from "@/lib/wallet/types";

export const metadata: Metadata = { title: "Wallet" };

// The signed-in user's balances, all derived on the server from the ledger.
// Only "Available" can be withdrawn; pending, held and paid-out amounts are
// shown separately and never added into it. If the read fails, error.tsx
// offers a retry.
export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const { summary, recent, destination, payoutsEnabled } = await getWalletOverview(user._id);
  const requested = first((await searchParams).payout) === "requested";

  const canWithdraw = payoutsEnabled && destination !== null && summary.availableKobo >= MIN_PAYOUT_KOBO;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Wallet" />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        {requested && (
          <FormAlert tone="success">
            Payout requested. The amount is set aside and will show as paid once your bank confirms it.
          </FormAlert>
        )}

        <section aria-labelledby="available-heading" className="rounded-3xl bg-primary p-5 text-primary-foreground shadow-sm">
          <h2 id="available-heading" className="text-sm font-medium text-primary-foreground/80">
            Available to withdraw
          </h2>
          <p className="mt-1 text-[2rem] leading-tight font-semibold tracking-tight tabular-nums">
            {formatKobo(summary.availableKobo)}
          </p>
          {canWithdraw ? (
            <Link
              href="/wallet/payout"
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-base font-medium text-primary outline-none hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
            >
              <Icon name="landmark" className="size-[18px]" />
              Request Payout
            </Link>
          ) : (
            <>
              <button
                type="button"
                disabled
                className="mt-4 flex h-12 w-full cursor-not-allowed items-center justify-center gap-2 rounded-full bg-white/25 text-base font-medium text-primary-foreground/80"
              >
                <Icon name="landmark" className="size-[18px]" />
                Request Payout
              </button>
              <p className="mt-2.5 text-xs leading-relaxed text-primary-foreground/85">
                {!payoutsEnabled
                  ? "Payouts aren't switched on yet. Your earnings stay safe in your wallet until they open."
                  : destination === null
                    ? "Add a verified bank account below to request payouts."
                    : `You can request a payout once at least ${formatKobo(MIN_PAYOUT_KOBO)} is available.`}
              </p>
            </>
          )}
        </section>

        {summary.owedKobo > 0 && (
          <div role="status" className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
            <Icon name="alert-circle" className="mt-px size-[18px] shrink-0" />
            <p>
              <span className="font-semibold">{formatKobo(summary.owedKobo)} to recover.</span> An order was refunded
              after its earnings had already been paid out to you. This amount comes out of your next earnings before
              you can withdraw again.
            </p>
          </div>
        )}

        <section aria-label="Other balances" className="grid grid-cols-2 gap-3">
          <BalanceCard
            icon="clock"
            label="Pending"
            amountKobo={summary.pendingKobo}
            note={
              summary.nextAvailableAt
                ? `Next available ${formatDate(summary.nextAvailableAt, true)}`
                : "Available 24 hours after delivery"
            }
          />
          <BalanceCard icon="landmark" label="Being paid out" amountKobo={summary.heldKobo} note="Set aside for payouts in progress" />
          <BalanceCard icon="check-circle" label="Paid out" amountKobo={summary.paidOutKobo} note="Sent to your bank" />
          {summary.underReviewKobo > 0 ? (
            <BalanceCard
              icon="alert-circle"
              label="Under review"
              amountKobo={summary.underReviewKobo}
              note="On hold while an order issue is looked into"
            />
          ) : (
            <Link
              href="/wallet/earnings"
              className="flex flex-col justify-between rounded-2xl bg-white p-3.5 text-sm font-medium text-primary shadow-sm ring-1 ring-foreground/5 outline-none hover:bg-primary/[0.03] focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon name="list" className="size-[18px]" />
              <span className="mt-3 flex items-center gap-1">
                Earnings breakdown
                <Icon name="chevron-right" className="size-4" />
              </span>
            </Link>
          )}
        </section>

        <section aria-labelledby="account-heading">
          <h2 id="account-heading" className="mb-2 text-sm font-semibold">
            Payout account
          </h2>
          <Link
            href="/profile/bank-details"
            className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3.5 shadow-sm ring-1 ring-foreground/5 outline-none hover:bg-primary/[0.03] focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
              <Icon name="landmark" className="size-[18px]" />
            </span>
            {destination ? (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9375rem] font-medium">{destination.bankName}</span>
                <span className="block font-mono text-xs tracking-wider text-muted-foreground">
                  <span className="sr-only">Account ending in {destination.accountNumberLast4}</span>
                  <span aria-hidden="true">{maskAccountNumber(destination.accountNumberLast4)}</span>
                </span>
              </span>
            ) : (
              <span className="flex-1 text-[0.9375rem] font-medium">Add a bank account</span>
            )}
            <Icon name="chevron-right" className="size-[18px] text-foreground/35" />
          </Link>
        </section>

        <section aria-labelledby="recent-heading">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="recent-heading" className="text-sm font-semibold">
              Recent transactions
            </h2>
            {recent.length > 0 && (
              <Link href="/wallet/transactions" className="text-sm font-medium text-primary hover:underline">
                See all
              </Link>
            )}
          </div>
          {recent.length ? (
            <ListCard label="Recent transactions">
              {recent.map((t) => (
                <TransactionRow key={t.id} transaction={t} />
              ))}
            </ListCard>
          ) : (
            <EmptyList icon="wallet" title="No transactions yet">
              Earnings from paid orders and bookings will appear here. They become available to withdraw 24 hours
              after delivery is confirmed.
            </EmptyList>
          )}
        </section>

        <div className="grid grid-cols-2 gap-3">
          <Link href="/wallet/earnings" className={buttonClasses("outline", "h-11 text-sm")}>
            Earnings
          </Link>
          <Link href="/wallet/payouts" className={buttonClasses("outline", "h-11 text-sm")}>
            Payout history
          </Link>
        </div>
      </div>
    </main>
  );
}

function BalanceCard({ icon, label, amountKobo, note }: { icon: IconName; label: string; amountKobo: number; note: string }) {
  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-foreground/5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon name={icon} className="size-3.5" />
        {label}
      </p>
      <p className="mt-1.5 text-lg font-semibold tabular-nums">{formatKobo(amountKobo)}</p>
      <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">{note}</p>
    </div>
  );
}
