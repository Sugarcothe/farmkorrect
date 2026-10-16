import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProductForm } from "@/components/orders/product-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { SELLER_ROLE } from "@/lib/server/products";

export const metadata: Metadata = { title: "New Listing" };

export default async function NewListingPage() {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== SELLER_ROLE) redirect("/market");
  return <ProductForm />;
}
