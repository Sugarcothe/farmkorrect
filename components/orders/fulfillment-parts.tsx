import { Icon } from "@/components/ui/icons";
import {
  FULFILLMENT_METHODS,
  NO_DELIVERY_FEE_NOTICE,
  type FulfillmentMethod,
  type OrderFulfillment,
  type ProductFulfillment,
} from "@/lib/orders/types";

// How buyers get the goods: picked up from the seller, or delivered by the
// seller. Farm Korret doesn't arrange, track or charge for either.

export const methodLabel = (method: FulfillmentMethod) => FULFILLMENT_METHODS.find((m) => m.value === method)!.label;

type Details = { areas?: string; timing?: string; instructions: string };

/** The seller's own words for one method; nothing is shown that they didn't give. */
export function MethodDetails({ method, details }: { method: FulfillmentMethod; details: Details }) {
  const rows =
    method === "pickup"
      ? [{ label: "Pickup instructions", value: details.instructions }]
      : [
          { label: "Delivers to", value: details.areas ?? "" },
          { label: "Timing", value: details.timing ?? "" },
          { label: "Instructions", value: details.instructions },
        ];
  const given = rows.filter((r) => r.value);
  if (given.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {method === "pickup" ? "Agree a pickup time and place with the seller." : "Agree the details with the seller."}
      </p>
    );
  return (
    <dl className="space-y-1">
      {given.map((r) => (
        <div key={r.label} className="text-xs leading-relaxed">
          <dt className="inline font-medium text-foreground/70">{r.label}: </dt>
          <dd className="inline whitespace-pre-line text-foreground/80">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The listing's methods, on the product page. */
export function FulfillmentOptions({ fulfillment }: { fulfillment: ProductFulfillment }) {
  const methods = FULFILLMENT_METHODS.filter((m) => fulfillment[m.value].enabled);
  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-foreground/5">
      <h3 className="text-sm font-semibold">Pickup &amp; delivery</h3>
      <ul className="mt-3 space-y-3">
        {methods.map((m) => (
          <li key={m.value} className="flex gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
              <Icon name={m.value === "pickup" ? "map-pin" : "home"} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{m.label}</p>
              <MethodDetails method={m.value} details={fulfillment[m.value]} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{NO_DELIVERY_FEE_NOTICE}</p>
    </section>
  );
}

/**
 * What the order records about how the buyer gets the goods, as the seller
 * described it when it was placed. Orders from before these options existed
 * only have the buyer's note.
 */
export function OrderFulfillmentDetails({ fulfillment }: { fulfillment: OrderFulfillment | null }) {
  if (!fulfillment)
    return <p className="text-xs text-muted-foreground">Placed before pickup and delivery options existed: arrange it with the other party.</p>;
  const first = fulfillment.details[0];
  // one block when every product says the same thing (always for one product)
  const same = fulfillment.details.every(
    (d) => d.areas === first.areas && d.timing === first.timing && d.instructions === first.instructions,
  );
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Icon name={fulfillment.method === "pickup" ? "map-pin" : "home"} className="size-4 text-primary" />
        {methodLabel(fulfillment.method)}
      </p>
      {same ? (
        <MethodDetails method={fulfillment.method} details={first} />
      ) : (
        <ul className="space-y-2">
          {fulfillment.details.map((d) => (
            <li key={d.productId}>
              <p className="text-xs font-medium">{d.name}</p>
              <MethodDetails method={fulfillment.method} details={d} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
