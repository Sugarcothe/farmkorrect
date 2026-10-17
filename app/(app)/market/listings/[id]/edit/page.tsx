import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductForm } from "@/components/orders/product-form";
import { first } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findOwnProduct, toProduct } from "@/lib/server/products";

export const metadata: Metadata = { title: "Edit Listing" };

/** After a new listing was saved but some of its photos weren't (?photos=failed&count=N). */
function photoNotice(photos: string | undefined, count: string | undefined): string | undefined {
  if (photos !== "failed") return undefined;
  const n = Number(count);
  const which = Number.isSafeInteger(n) && n > 1 && n <= 5 ? `${n} of your photos weren't` : "A photo wasn't";
  return `Your listing was saved, but ${which} uploaded. Add them again below.`;
}

// Only the signed-in owner's own, current listing; any other id is a 404.
export default async function EditListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const product = await findOwnProduct(user._id, (await params).id);
  if (!product) notFound();
  const query = await searchParams;
  return <ProductForm product={toProduct(product)} photoNotice={photoNotice(first(query.photos), first(query.count))} />;
}
