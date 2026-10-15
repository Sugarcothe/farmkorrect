import type { Metadata } from "next";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, formatDate, Pager, StatusBadge, WalletTabs } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { HttpError } from "@/lib/server/http";
import { listEarnings } from "@/lib/server/ledger";
import { PAGE_SIZE, parsePage } from "@/lib/server/wallet";
import { formatKobo } from "@/lib/wallet/money";
import type { Earning } from "@/lib/wallet/types";

export const metadata: Metadata = { title: "Earnings" };

const SOURCE_LABEL: Record<Earning["sourceType"], string> = { order: "Order", service_booking: "Booking" };

// Each paid order or booking: what was charged, the fee recorded with the
// payment, any refunds, and when it becomes (or became) withdrawable.
export default async function EarningsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const pageParam = first((await searchParams).page);
  let page = 1;
  try {
    page = parsePage(new URLSearchParams(pageParam ? { page: pageParam } : {}));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
  }
  const { earnings, hasMore } = await listEarnings(user._id, { page, pageSize: PAGE_SIZE });

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Earnings" back={<BackLink href="/wallet" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <WalletTabs current="earnings" />
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          Earnings become available to withdraw 24 hours after delivery is confirmed. Fees are the platform fees
          recorded with each payment.
        </p>
        {earnings.length ? (
          <ul aria-label="Earnings" className="space-y-3">
            {earnings.map((e) => (
              <li key={`${e.sourceType}:${e.reference}`} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{SOURCE_LABEL[e.sourceType]}</p>
                    <p className="truncate font-mono text-sm">{e.reference}</p>
                  </div>
                  <StatusBadge status={e.status} />
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-foreground/8 pt-3 text-sm">
                  <Amount label="Gross" kobo={e.grossKobo} />
                  <Amount label="Fees" kobo={e.feesKobo} negative />
                  <Amount label={e.refundedKobo ? "Net after refunds" : "Net"} kobo={e.netKobo} strong />
                </dl>
                {e.refundedKobo > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">Refunded: {formatKobo(e.refundedKobo)}</p>
                )}
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {e.deliveredAt ? (
                    <>
                      Delivered {formatDate(e.deliveredAt, true)}
                      {e.availableAt && e.status !== "refunded" && (
                        <>
                          {" · "}
                          {e.status === "available" ? "available since" : "available from"} {formatDate(e.availableAt, true)}
                        </>
                      )}
                    </>
                  ) : (
                    "Waiting for delivery to be confirmed"
                  )}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyList icon="wallet" title={page > 1 ? "No more earnings" : "No earnings yet"}>
            Each paid order or booking will be listed here with its fees and when the money becomes available.
          </EmptyList>
        )}
        <Pager
          newer={page > 1 ? `/wallet/earnings${page > 2 ? `?page=${page - 1}` : ""}` : null}
          older={hasMore ? `/wallet/earnings?page=${page + 1}` : null}
        />
      </div>
    </main>
  );
}

function Amount({ label, kobo, negative, strong }: { label: string; kobo: number; negative?: boolean; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 truncate tabular-nums ${strong ? "font-semibold" : ""}`}>
        {negative && kobo > 0 ? "−" : ""}
        {formatKobo(kobo)}
      </dd>
    </div>
  );
}
