"use client";

import { useState } from "react";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { placeOrder, startCheckout } from "@/lib/orders/api";
import { FULFILLMENT_METHODS, NO_DELIVERY_FEE_NOTICE, ORDER_LIMITS, type MarketProduct } from "@/lib/orders/types";
import {
  isFulfillmentMethod,
  sharedFulfillmentMethods,
  validateDeliveryNote,
  validateQuantity,
} from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";
import { useForm } from "@/lib/use-form";
import { formatKobo } from "@/lib/wallet/money";
import { MethodDetails } from "./fulfillment-parts";
import { unitName } from "./order-parts";

type Values = { quantity: string; method: string; deliveryNote: string };

const parseQuantity = (value: string) => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : NaN);

/**
 * Places an order for one listing and sends the buyer to Paystack's checkout.
 * Only the product, quantity, pickup or delivery and a note are sent: the
 * server prices the order from the database, refuses it if the total isn't
 * the one shown here, and checks the seller still offers the chosen method.
 * Choosing delivery adds nothing to the total. One idempotency key per visit, so a double tap or a retry after
 * a dropped connection returns the same order instead of a second one.
 */
export function BuyForm({ product }: { product: MarketProduct }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedOrderId, setSavedOrderId] = useState<string | null>(null);

  const methods = sharedFulfillmentMethods([product.fulfillment]);
  // a choice is only made for the buyer when there's nothing to choose between
  const form = useForm<Values>({ quantity: "1", method: methods.length === 1 ? methods[0] : "", deliveryNote: "" }, (v) => ({
    quantity: validateQuantity(parseQuantity(v.quantity), product.stockQuantity),
    method: isFulfillmentMethod(v.method) && methods.includes(v.method) ? undefined : "Choose pickup or delivery.",
    deliveryNote: validateDeliveryNote(v.deliveryNote),
  }));
  const locked = submitting || savedOrderId !== null;

  const quantity = parseQuantity(form.values.quantity);
  const total = Number.isSafeInteger(quantity) && quantity > 0 ? quantity * product.priceKobo : null;
  const methodError = form.errors.method;

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitting || total === null || !isFulfillmentMethod(values.method)) return;
    setSubmitting(true);
    setFormError(null);

    const placed = await placeOrder({
      items: [{ productId: product.id, quantity: parseQuantity(values.quantity) }],
      fulfillmentMethod: values.method,
      deliveryNote: cleanText(values.deliveryNote, true),
      idempotencyKey,
      expectedTotalKobo: total,
    });
    if (!placed.ok) {
      setSubmitting(false);
      setFormError(placed.error);
      if (placed.fieldErrors?.fulfillmentMethod) form.setServerErrors({ method: placed.fieldErrors.fulfillmentMethod });
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
        disabled={locked}
        {...form.field("quantity")}
      />

      <fieldset aria-describedby={methodError ? "buy-method-error" : undefined}>
        <legend className="mb-1.5 text-sm font-medium">How will you get it?</legend>
        <div className="space-y-2">
          {FULFILLMENT_METHODS.filter((m) => methods.includes(m.value)).map((m) => {
            const selected = form.values.method === m.value;
            return (
              <label
                key={m.value}
                className={`flex cursor-pointer gap-3 rounded-2xl bg-white px-4 py-3 ring-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                  selected ? "ring-primary" : "ring-foreground/10"
                } ${locked ? "cursor-not-allowed opacity-70" : ""}`}
              >
                <input
                  type="radio"
                  name="method"
                  value={m.value}
                  checked={selected}
                  disabled={locked}
                  onChange={() => form.setValue("method", m.value)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{m.label}</span>
                  <MethodDetails method={m.value} details={product.fulfillment[m.value]} />
                </span>
              </label>
            );
          })}
        </div>
        {methodError && (
          <p id="buy-method-error" className="mt-1.5 text-xs text-red-600">
            {methodError}
          </p>
        )}
      </fieldset>

      <TextAreaField
        label={form.values.method === "pickup" ? "Your contact details" : "Delivery details"}
        placeholder={
          form.values.method === "pickup"
            ? "When you plan to collect it, and how the seller can reach you"
            : "Where should it go, and how can the seller reach you there?"
        }
        maxLength={ORDER_LIMITS.deliveryNote.max + 50}
        hint="Only the seller of this order sees this."
        disabled={locked}
        {...form.field("deliveryNote")}
      />

      <div className="flex items-center justify-between rounded-2xl bg-white px-4 py-3 ring-1 ring-foreground/8">
        <span className="text-sm text-muted-foreground">Total to pay</span>
        <span className="text-lg font-semibold tabular-nums">{total === null ? "—" : formatKobo(total)}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {NO_DELIVERY_FEE_NOTICE} No tax is added. Your order holds the stock for 30 minutes while you pay with Paystack.
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
