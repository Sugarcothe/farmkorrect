import type { Metadata } from "next";
import Link from "next/link";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, ListCard, Pager, TransactionRow, WalletTabs } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { HttpError } from "@/lib/server/http";
import { listTransactions } from "@/lib/server/ledger";
import { PAGE_SIZE, parseTransactionQuery } from "@/lib/server/wallet";
import type { TransactionFilter } from "@/lib/wallet/types";

export const metadata: Metadata = { title: "Transactions" };

const FILTERS: { value: TransactionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "credits", label: "Money in" },
  { value: "debits", label: "Money out" },
  { value: "earnings", label: "Earnings" },
  { value: "payouts", label: "Payouts" },
];

const hrefFor = (filter: TransactionFilter, before?: string) => {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (before) params.set("before", before);
  const query = params.toString();
  return `/wallet/transactions${query ? `?${query}` : ""}`;
};

// Every ledger entry for the signed-in user, newest first.
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["filter", "before"]) {
    const value = first(raw[key]);
    if (value) params.set(key, value);
  }
  let query: ReturnType<typeof parseTransactionQuery>;
  try {
    query = parseTransactionQuery(params);
  } catch (error) {
    // a mistyped link shows the first page rather than an error
    if (!(error instanceof HttpError)) throw error;
    query = { filter: "all", before: null, limit: PAGE_SIZE };
  }
  const { transactions, nextCursor } = await listTransactions(user._id, query);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Transactions" back={<BackLink href="/wallet" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <WalletTabs current="transactions" />
        <nav aria-label="Filter" className="-mx-5 mb-4 flex gap-2 overflow-x-auto px-5 pb-1">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={hrefFor(f.value)}
              aria-current={f.value === query.filter ? "true" : undefined}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-[0.8125rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                f.value === query.filter ? "bg-primary text-primary-foreground" : "bg-white text-foreground/70 ring-1 ring-foreground/10"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </nav>

        {transactions.length ? (
          <ListCard label="Transactions">
            {transactions.map((t) => (
              <TransactionRow key={t.id} transaction={t} />
            ))}
          </ListCard>
        ) : (
          <EmptyList icon="list" title={query.before ? "No older transactions" : "Nothing here yet"}>
            {query.filter === "all"
              ? "Earnings, fees, refunds and payouts will be listed here as they happen."
              : "No transactions match this filter."}
          </EmptyList>
        )}
        <Pager
          newer={query.before ? hrefFor(query.filter) : null}
          older={nextCursor ? hrefFor(query.filter, nextCursor) : null}
        />
      </div>
    </main>
  );
}
