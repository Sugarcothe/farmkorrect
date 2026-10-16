import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductForm } from "@/components/orders/product-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findOwnProduct, toProduct } from "@/lib/server/products";

export const metadata: Metadata = { title: "Edit Listing" };

// Only the signed-in owner's own, current listing; any other id is a 404.
export default async function EditListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const product = await findOwnProduct(user._id, (await params).id);
  if (!product) notFound();
  return <ProductForm product={toProduct(product)} />;
}
