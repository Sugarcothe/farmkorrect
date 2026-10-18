import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { StatePill } from "@/components/promotions/promotion-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { EmptyList, formatDate, ListCard } from "@/components/wallet/wallet-parts";
import { offerLabel } from "@/lib/promotions/types";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { SELLER_ROLE } from "@/lib/server/products";
import { listOwnPromotions } from "@/lib/server/promotions";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Promotions" };

// The signed-in farmer's own sales and coupon codes, read from the database.
export default async function PromotionsPage() {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== SELLER_ROLE) redirect("/market");
  const promotions = await listOwnPromotions(user._id);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Promotions" back={<BackLink href="/market/listings" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <Link href="/market/promotions/new" className={buttonClasses("solid", "gap-2")}>
          <Icon name="plus" className="size-5" />
          New promotion
        </Link>
        {promotions.length ? (
          <ListCard label="Your promotions">
            {promotions.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/market/promotions/${p.id}`}
                  className="flex items-center gap-3 px-4 py-3.5 outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {offerLabel(p, formatKobo)}
                      {p.code ? ` · code ${p.code}` : " · automatic"} · ends {formatDate(p.endsAt)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.stats.redeemedCount} paid {p.stats.redeemedCount === 1 ? "order" : "orders"} ·{" "}
                      {formatKobo(p.stats.discountKobo)} given
                    </p>
                  </div>
                  <StatePill state={p.state} />
                  <Icon name="chevron-right" className="size-[18px] text-foreground/35" />
                </Link>
              </li>
            ))}
          </ListCard>
        ) : (
          <EmptyList icon="store" title="No promotions yet">
            Run a sale on your products or share a coupon code. You fund the discount; buyers see it once you activate it.
          </EmptyList>
        )}
      </div>
    </main>
  );
}
