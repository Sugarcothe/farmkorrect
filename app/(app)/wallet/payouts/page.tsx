import type { Metadata } from "next";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, ListCard, Pager, PayoutRow, WalletTabs } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { HttpError } from "@/lib/server/http";
import { listPayouts } from "@/lib/server/payouts";
import { PAGE_SIZE, parsePage } from "@/lib/server/wallet";

export const metadata: Metadata = { title: "Payouts" };

// The signed-in user's payout requests and what happened to each.
export default async function PayoutsPage({
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
  const { payouts, hasMore } = await listPayouts(user._id, { page, pageSize: PAGE_SIZE });

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Payouts" back={<BackLink href="/wallet" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <WalletTabs current="payouts" />
        {payouts.length ? (
          <ListCard label="Payouts">
            {payouts.map((p) => (
              <PayoutRow key={p.id} payout={p} />
            ))}
          </ListCard>
        ) : (
          <EmptyList icon="landmark" title={page > 1 ? "No older payouts" : "No payouts yet"}>
            When you request a payout from your available balance, you can follow it here until your bank confirms it.
          </EmptyList>
        )}
        <Pager
          newer={page > 1 ? `/wallet/payouts${page > 2 ? `?page=${page - 1}` : ""}` : null}
          older={hasMore ? `/wallet/payouts?page=${page + 1}` : null}
        />
      </div>
    </main>
  );
}
