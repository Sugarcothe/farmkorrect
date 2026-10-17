import Link from "next/link";
import { categoryLabel, unitLabel } from "@/components/orders/order-parts";
import { Icon } from "@/components/ui/icons";
import { stateLabel } from "@/lib/locations/nigeria";
import type { MarketProduct } from "@/lib/orders/types";
import { formatKobo } from "@/lib/wallet/money";

/** "Nsukka, Enugu", "Enugu", or null when the seller hasn't given a location. */
export function productPlace(product: Pick<MarketProduct, "state" | "area">): string | null {
  if (!product.state) return null;
  return product.area ? `${product.area}, ${stateLabel(product.state)}` : stateLabel(product.state);
}

function availability(stock: number) {
  if (stock <= 0) return { text: "Sold out", className: "text-red-700" };
  return { text: `${stock.toLocaleString("en-NG")} available`, className: "text-foreground/60" };
}

/**
 * A Market listing. Everything shown comes from the listing and its
 * published reviews: no rating is drawn for a product nobody has reviewed,
 * and no place for one whose seller hasn't given it.
 */
export function ProductCard({ product: p }: { product: MarketProduct }) {
  const place = productPlace(p);
  const stock = availability(p.stockQuantity);
  return (
    <Link
      href={`/market/${p.id}`}
      className="flex h-full flex-col rounded-3xl bg-white p-3.5 shadow-sm ring-1 ring-foreground/5 outline-none hover:ring-primary/30 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="flex size-10 items-center justify-center rounded-2xl bg-primary/8 text-primary">
          <Icon name="egg" className="size-5" />
        </span>
        {p.rating && (
          <span
            className="flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold tabular-nums text-amber-800"
            aria-label={`Rated ${p.rating.average.toFixed(1)} out of 5 from ${p.rating.count} ${p.rating.count === 1 ? "review" : "reviews"}`}
          >
            <Icon name="star" className="size-3 fill-current" />
            {p.rating.average.toFixed(1)}
            <span className="font-normal text-amber-800/70">({p.rating.count})</span>
          </span>
        )}
      </span>
      <span className="mt-2.5 line-clamp-2 text-sm font-semibold">{p.name}</span>
      <span className="mt-0.5 text-[0.6875rem] text-muted-foreground">{categoryLabel(p.category)}</span>
      <span className="mt-auto pt-2 text-sm font-semibold tabular-nums text-primary">{formatKobo(p.priceKobo)}</span>
      <span className="text-[0.6875rem] text-muted-foreground">{unitLabel(p.unit)}</span>
      <span className={`mt-1 text-[0.6875rem] font-medium tabular-nums ${stock.className}`}>{stock.text}</span>
      {place && (
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[0.6875rem] text-foreground/60">
          <Icon name="map-pin" className="size-3 shrink-0" />
          <span className="truncate">{place}</span>
        </span>
      )}
      <span className="mt-0.5 truncate text-[0.6875rem] text-foreground/60">{p.own ? "Your listing" : p.sellerName}</span>
    </Link>
  );
}
