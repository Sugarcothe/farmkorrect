"use client";

import { useState } from "react";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { placeOrder, startCheckout } from "@/lib/orders/api";
import { ORDER_LIMITS, type MarketProduct } from "@/lib/orders/types";
import { validateDeliveryNote, validateQuantity } from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";
import { useForm } from "@/lib/use-form";
import { formatKobo } from "@/lib/wallet/money";
import { unitName } from "./order-parts";

type Values = { quantity: string; deliveryNote: string };

const parseQuantity = (value: string) => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : NaN);

/**
 * Places an order for one listing and sends the buyer to Paystack's checkout.
 * Only the product, quantity and delivery note are sent: the server prices
 * the order from the database and refuses it if the total isn't the one
 * shown here. One idempotency key per visit, so a double tap or a retry after
 * a dropped connection returns the same order instead of a second one.
 */
export function BuyForm({ product }: { product: MarketProduct }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedOrderId, setSavedOrderId] = useState<string | null>(null);

  const form = useForm<Values>({ quantity: "1", deliveryNote: "" }, (v) => ({
    quantity: validateQuantity(parseQuantity(v.quantity), product.stockQuantity),
    deliveryNote: validateDeliveryNote(v.deliveryNote),
  }));

  const quantity = parseQuantity(form.values.quantity);
  const total = Number.isSafeInteger(quantity) && quantity > 0 ? quantity * product.priceKobo : null;

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitting || total === null) return;
    setSubmitting(true);
    setFormError(null);

    const placed = await placeOrder({
      items: [{ productId: product.id, quantity: parseQuantity(values.quantity) }],
      deliveryNote: cleanText(values.deliveryNote, true),
      idempotencyKey,
      expectedTotalKobo: total,
    });
    if (!placed.ok) {
      setSubmitting(false);
      setFormError(placed.error);
      return;
    }

    const orderId = placed.data.order.id;
    setSavedOrderId(orderId);
    const checkout = await startCheckout(orderId);
    if (!checkout.ok) {
      setSubmitting(false);
      setFormError(`Your order is saved, but payment couldn't start: ${checkout.error}`);
      return;
    }
    // stays locked while the browser leaves for Paystack
    window.location.assign(checkout.data.authorizationUrl);
  });

  if (product.own)
    return <FormAlert tone="success">This is your own listing. Other Farm Korret users can order it here.</FormAlert>;
  if (product.stockQuantity === 0) return <FormAlert>This product is sold out right now.</FormAlert>;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <TextField
        label="Quantity"
        inputMode="numeric"
        hint={`${product.stockQuantity} ${unitName(product.unit, product.stockQuantity)} available`}
        disabled={submitting || savedOrderId !== null}
        {...form.field("quantity")}
      />
      <TextAreaField
        label="Delivery details"
        placeholder="Where should it go, and how can the seller reach you there?"
        maxLength={ORDER_LIMITS.deliveryNote.max + 50}
        hint="Only the seller of this order sees this."
        disabled={submitting || savedOrderId !== null}
        {...form.field("deliveryNote")}
      />

      <div className="flex items-center justify-between rounded-2xl bg-white px-4 py-3 ring-1 ring-foreground/8">
        <span className="text-sm text-muted-foreground">Total to pay</span>
        <span className="text-lg font-semibold tabular-nums">{total === null ? "—" : formatKobo(total)}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        No delivery fee or tax is added; arrange delivery with the seller. Your order holds the stock for 30 minutes
        while you pay with Paystack.
      </p>

      {formError && <FormAlert>{formError}</FormAlert>}

      {savedOrderId && !submitting ? (
        <Link
          href={`/orders/${savedOrderId}`}
          className="flex h-12 w-full items-center justify-center rounded-full bg-primary px-5 text-base font-medium text-primary-foreground hover:bg-primary-dark"
        >
          Go to your order
        </Link>
      ) : (
        <Button type="submit" loading={submitting}>
          {submitting ? "Starting payment…" : "Order and pay"}
        </Button>
      )}
    </form>
  );
}
