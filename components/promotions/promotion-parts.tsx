import { offerLabel, PROMOTION_STATE_LABELS, type PromotionFields, type PromotionState } from "@/lib/promotions/types";
import { formatKobo } from "@/lib/wallet/money";
import { formatDate } from "@/components/wallet/wallet-parts";

// Shared pieces for the seller's promotion pages.

const STATE_TONE: Record<PromotionState, string> = {
  live: "bg-emerald-50 text-emerald-800",
  scheduled: "bg-sky-50 text-sky-800",
  draft: "bg-foreground/6 text-foreground/70",
  paused: "bg-amber-50 text-amber-800",
  expired: "bg-foreground/6 text-foreground/60",
  used_up: "bg-foreground/6 text-foreground/60",
  ended: "bg-foreground/6 text-foreground/60",
};

export function StatePill({ state }: { state: PromotionState }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_TONE[state]}`}>{PROMOTION_STATE_LABELS[state]}</span>
  );
}

type Terms = Pick<
  PromotionFields,
  "type" | "value" | "code" | "startsAt" | "endsAt" | "minOrderKobo" | "maxDiscountKobo" | "totalLimit" | "perBuyerLimit" | "scope"
> & { productNames: string[] };

/** The promotion's terms in plain words, as buyers and the seller should read them. */
export function termsOf(t: Terms): string[] {
  const lines = [
    `${offerLabel(t, formatKobo)} ${
      t.scope === "all" ? "all your products" : t.productNames.length ? t.productNames.join(", ") : "the chosen products"
    }`,
    t.code ? `Buyers enter the code ${t.code} at checkout` : "Applied automatically at checkout (no code needed)",
    `From ${formatDate(t.startsAt, true)} to ${formatDate(t.endsAt, true)}`,
  ];
  if (t.minOrderKobo !== null) lines.push(`Only when the buyer spends at least ${formatKobo(t.minOrderKobo)} on these products`);
  if (t.maxDiscountKobo !== null) lines.push(`At most ${formatKobo(t.maxDiscountKobo)} off an order`);
  if (t.totalLimit !== null) lines.push(`Up to ${t.totalLimit.toLocaleString("en-NG")} orders in total`);
  if (t.perBuyerLimit !== null) lines.push(`Up to ${t.perBuyerLimit} ${t.perBuyerLimit === 1 ? "order" : "orders"} per buyer`);
  lines.push("One offer per order; buyers always pay at least ₦1");
  return lines;
}

export function TermsList({ terms }: { terms: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground/80">
      {terms.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
