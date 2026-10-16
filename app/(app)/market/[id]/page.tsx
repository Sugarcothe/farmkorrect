import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyForm } from "@/components/orders/buy-form";
import { categoryLabel, unitLabel } from "@/components/orders/order-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findMarketProduct } from "@/lib/server/products";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Product" };

export default async function MarketProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const product = await findMarketProduct(user._id, (await params).id);
  if (!product) notFound();

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Product" back={<BackLink href="/market" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-foreground/5">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/8 text-primary">
            <Icon name="egg" className="size-6" />
          </span>
          <h2 className="mt-3 text-xl font-semibold tracking-tight">{product.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {categoryLabel(product.category)} · sold by {product.own ? "you" : product.sellerName}
          </p>
          <p className="mt-3 text-2xl font-bold tabular-nums text-primary">
            {formatKobo(product.priceKobo)}{" "}
            <span className="text-sm font-medium text-muted-foreground">{unitLabel(product.unit)}</span>
          </p>
          {product.description && (
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-foreground/75">{product.description}</p>
          )}
        </section>
        <BuyForm product={product} />
      </div>
    </main>
  );
}
