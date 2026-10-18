import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Facts } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { PromotionActions } from "@/components/promotions/promotion-actions";
import { StatePill, termsOf, TermsList } from "@/components/promotions/promotion-parts";
import { first, formatDate } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { SELLER_ROLE } from "@/lib/server/products";
import { findOwnPromotion, toPromotions } from "@/lib/server/promotions";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Promotion" };

const SAVED_NOTICE: Record<string, string> = {
  created: "Saved as a draft. Activate it when you're ready.",
  updated: "Changes saved.",
  activate: "Promotion activated.",
  pause: "Promotion paused.",
  end: "Promotion ended.",
};

// One of the signed-in farmer's promotions: its terms, how it's doing, and
// the status controls. Another seller's id (or a made-up one) is a 404.
export default async function PromotionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== SELLER_ROLE) redirect("/market");
  const doc = await findOwnPromotion(user._id, (await params).id);
  if (!doc) notFound();
  const [promotion] = await toPromotions([doc]);
  const saved = first((await searchParams).saved);
  const notice = saved && Object.hasOwn(SAVED_NOTICE, saved) ? SAVED_NOTICE[saved] : null;
  const { stats } = promotion;
  const count = (n: number) => n.toLocaleString("en-NG");

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Promotion" back={<BackLink href="/market/promotions" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        {notice && <FormAlert tone="success">{notice}</FormAlert>}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold break-words">{promotion.name}</h1>
            {promotion.description && <p className="mt-1 text-sm text-muted-foreground">{promotion.description}</p>}
          </div>
          <StatePill state={promotion.state} />
        </div>
        <div className="rounded-3xl bg-white px-4 py-3.5 shadow-sm ring-1 ring-foreground/5">
          <TermsList terms={termsOf({ ...promotion, productNames: promotion.products.map((p) => p.name) })} />
        </div>
        <Facts
          label="Performance"
          rows={[
            ["Paid orders", count(stats.redeemedCount)],
            ["Awaiting payment", `${count(stats.reservedCount)} (each holds a use until paid or cancelled)`],
            ["Discount given", formatKobo(stats.discountKobo)],
            ["Buyers paid", formatKobo(stats.paidKobo)],
            [
              "Uses",
              promotion.totalLimit === null
                ? `${count(promotion.redemptionCount)} (no limit)`
                : `${count(promotion.redemptionCount)} of ${count(promotion.totalLimit)}`,
            ],
            ["Created", formatDate(promotion.createdAt, true)],
            ["Last changed", formatDate(promotion.updatedAt, true)],
          ]}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          You fund this discount: your earnings come from what buyers actually pay. Pausing or ending it never changes orders
          already placed.
        </p>
        <PromotionActions promotion={promotion} />
      </div>
    </main>
  );
}
