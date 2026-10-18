import { formatDate } from "@/components/wallet/wallet-parts";
import { offerLabel, type ProductOffer } from "@/lib/promotions/types";
import { formatKobo } from "@/lib/wallet/money";

// A seller's live sale on a Market listing. Only automatic sales that are
// running right now reach here; the final price is always worked out at
// checkout, so these words never promise more than the server will give.

export function OfferBadge({ offer, className = "" }: { offer: ProductOffer; className?: string }) {
  return (
    <span className={`rounded-full bg-red-600 px-2 py-0.5 text-[0.6875rem] font-semibold text-white shadow-sm ${className}`}>
      {offerLabel(offer, formatKobo)}
    </span>
  );
}

/** "₦4,500 ₦4,050": the sale price beside the struck-out price, when one unit's sale price is certain. */
export function OfferPrice({ priceKobo, offer, className = "" }: { priceKobo: number; offer: ProductOffer | null; className?: string }) {
  if (!offer || offer.salePriceKobo === null) return <span className={className}>{formatKobo(priceKobo)}</span>;
  return (
    <span className={className}>
      <span className="sr-only">Sale price </span>
      {formatKobo(offer.salePriceKobo)}{" "}
      <s className="text-[0.75em] font-normal text-muted-foreground">
        <span className="sr-only">was </span>
        {formatKobo(priceKobo)}
      </s>
    </span>
  );
}

export function offerTerms(offer: ProductOffer): string[] {
  const terms: string[] = [];
  if (offer.minOrderKobo !== null) terms.push(`When you spend at least ${formatKobo(offer.minOrderKobo)} on the products it covers`);
  if (offer.maxDiscountKobo !== null) terms.push(`Up to ${formatKobo(offer.maxDiscountKobo)} off an order`);
  terms.push(`Ends ${formatDate(offer.endsAt, true)}`);
  terms.push("Applied automatically at checkout. One offer per order; a coupon code replaces it.");
  return terms;
}

export function OfferTerms({ offer }: { offer: ProductOffer }) {
  return (
    <div className="mt-3 rounded-2xl bg-red-50 px-3.5 py-2.5 text-xs leading-relaxed text-red-900">
      <p className="font-semibold">
        {offer.name}: {offerLabel(offer, formatKobo)}
      </p>
      <ul className="mt-1 list-disc pl-4">
        {offerTerms(offer).map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
