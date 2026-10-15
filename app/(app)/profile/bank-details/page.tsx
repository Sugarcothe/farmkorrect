import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import type { BankAccountSummary } from "@/lib/bank-details/types";
import { maskAccountNumber } from "@/lib/bank-details/validation";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findCurrentAccount, toSummary } from "@/lib/server/payout-accounts";
import { isPaystackConfigured } from "@/lib/server/paystack";

export const metadata: Metadata = { title: "Bank Details" };

const SAVED_NOTICE: Record<string, string> = {
  added: "Bank account saved and verified with Paystack.",
  changed: "Bank account changed. Future payouts will go to the new account.",
};

const SETUP_PATH = "/profile/bank-details/setup";

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" }).format(
    new Date(iso),
  );
}

// The signed-in user's payout account, read straight from the database for
// the account in the session. Only the last four digits are ever shown. If
// the read fails, error.tsx offers a retry.
export default async function BankDetailsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const current = await findCurrentAccount(user._id);
  const account = current ? toSummary(current) : null;
  const configured = isPaystackConfigured();
  const saved = (await searchParams).saved;
  const notice = typeof saved === "string" && Object.hasOwn(SAVED_NOTICE, saved) ? SAVED_NOTICE[saved] : null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Bank Details" back={<BackLink href="/profile" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <h2 className="text-xl font-semibold tracking-tight">Payout account</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          The bank account your earnings will be paid into. We check every account with Paystack, our payment
          partner, before saving it.
        </p>
        <p className="mt-3 mb-5 flex gap-2 rounded-xl bg-primary/6 px-3.5 py-2.5 text-xs leading-relaxed text-primary">
          <Icon name="wallet" className="mt-px size-4 shrink-0" />
          Payouts aren&apos;t available yet. Saving an account doesn&apos;t move any money; it gets you ready for
          when they launch.
        </p>

        {notice && (
          <div className="mb-4">
            <FormAlert tone="success">{notice}</FormAlert>
          </div>
        )}

        {account ? (
          <AccountCard account={account} canChange={configured} />
        ) : (
          <EmptyState configured={configured} />
        )}
      </div>
    </main>
  );
}

function AccountCard({ account, canChange }: { account: BankAccountSummary; canChange: boolean }) {
  return (
    <section aria-labelledby="account-heading" className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-foreground/5">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/8 text-primary">
          <Icon name="landmark" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="account-heading" className="text-base leading-snug font-semibold break-words">
            {account.bankName}
          </h3>
          <p className="mt-0.5 font-mono text-sm tracking-wider text-muted-foreground">
            <span className="sr-only">Account number ending in </span>
            <span aria-hidden="true">{maskAccountNumber(account.accountNumberLast4)}</span>
            <span className="sr-only">{account.accountNumberLast4}</span>
          </p>
        </div>
      </div>

      <dl className="mt-4 space-y-3 border-t border-foreground/8 pt-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Account name</dt>
          <dd className="mt-0.5 font-medium break-words">{account.accountName}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd className="mt-1">
            {account.readyForPayouts ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                <Icon name="shield-check" className="size-3.5" />
                Verified with Paystack · ready for payouts
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                <Icon name="alert-circle" className="size-3.5" />
                Setup incomplete
              </span>
            )}
          </dd>
        </div>
        {account.verifiedAt && (
          <div>
            <dt className="text-xs text-muted-foreground">Verified on</dt>
            <dd className="mt-0.5 font-medium">{formatDate(account.verifiedAt)}</dd>
          </div>
        )}
      </dl>

      {canChange ? (
        <Link href={SETUP_PATH} className={buttonClasses("outline", "mt-5 gap-2")}>
          <Icon name="pencil" className="size-4" />
          Change Bank Account
        </Link>
      ) : (
        <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
          Changing your bank account isn&apos;t available right now. Please try again later.
        </p>
      )}
    </section>
  );
}

function EmptyState({ configured }: { configured: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-foreground/5">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/8 text-primary">
        <Icon name="landmark" className="size-7" />
      </div>
      <h3 className="mt-4 text-base font-semibold">No bank account yet</h3>
      {configured ? (
        <>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
            Add the Nigerian bank account you&apos;d like to be paid into. We&apos;ll show you the account name your
            bank has on record before anything is saved.
          </p>
          <Link href={SETUP_PATH} className={buttonClasses("solid", "mt-6 max-w-xs gap-2")}>
            <Icon name="plus" className="size-[18px]" />
            Add Bank Account
          </Link>
        </>
      ) : (
        <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
          Bank verification isn&apos;t available right now, so accounts can&apos;t be added yet. Please check back
          later.
        </p>
      )}
    </div>
  );
}
