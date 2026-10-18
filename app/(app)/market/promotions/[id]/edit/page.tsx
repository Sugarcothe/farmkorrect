import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PromotionForm } from "@/components/promotions/promotion-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { listOwnProducts, SELLER_ROLE } from "@/lib/server/products";
import { findOwnPromotion, toPromotions } from "@/lib/server/promotions";

export const metadata: Metadata = { title: "Edit Promotion" };

// Only drafts and paused promotions can be edited; the server refuses others too.
export default async function EditPromotionPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== SELLER_ROLE) redirect("/market");
  const { id } = await params;
  const doc = await findOwnPromotion(user._id, id);
  if (!doc) notFound();
  if (doc.status !== "draft" && doc.status !== "paused") redirect(`/market/promotions/${id}`);
  const [[promotion], products] = await Promise.all([toPromotions([doc]), listOwnProducts(user._id)]);
  return (
    <PromotionForm promotion={promotion} products={products.map((p) => ({ id: p.id, name: p.name, priceKobo: p.priceKobo }))} />
  );
}
