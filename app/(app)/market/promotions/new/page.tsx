import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PromotionForm } from "@/components/promotions/promotion-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { listOwnProducts, SELLER_ROLE } from "@/lib/server/products";

export const metadata: Metadata = { title: "New Promotion" };

export default async function NewPromotionPage() {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== SELLER_ROLE) redirect("/market");
  const products = (await listOwnProducts(user._id)).map((p) => ({ id: p.id, name: p.name, priceKobo: p.priceKobo }));
  return <PromotionForm products={products} />;
}
