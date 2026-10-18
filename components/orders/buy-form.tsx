"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { placeOrder, startCheckout } from "@/lib/orders/api";
import { quoteOrder } from "@/lib/promotions/api";
import { normalizeCouponCode, type Quote } from "@/lib/promotions/types";
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

/** A server quote, with what it was asked for so a stale one is never used. */
type PricedQuote = { quantity: number; code: string | null; quote: Quote };

/**
 * Places an order for one listing and sends the buyer to Paystack's checkout.
 * Only the product, quantity, pickup or delivery and a note are sent: the
 * server prices the order from the database, refuses it if the total isn't
 * the one shown here, and checks the seller still offers the chosen method.
 * Choosing delivery adds nothing to the total. One idempotency key per visit, so a double tap or a retry after
 * a dropped connection returns the same order instead of a second one.
 *
 * Prices, including any sale or coupon, come only from the server's quote;
 * the total sent back is the quoted one, and the server works it out again
 * and refuses the order if it differs.
 */
export function BuyForm({ product }: { product: MarketProduct }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedOrderId, setSavedOrderId] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState("");
  /** the code the buyer applied and the server accepted */
  const [code, setCode] = useState<string | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [priced, setPriced] = useState<PricedQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const methods = sharedFulfillmentMethods([product.fulfillment]);
  // a choice is only made for the buyer when there's nothing to choose between
  const form = useForm<Values>({ quantity: "1", method: methods.length === 1 ? methods[0] : "", deliveryNote: "" }, (v) => ({
    quantity: validateQuantity(parseQuantity(v.quantity), product.stockQuantity),
    method: isFulfillmentMethod(v.method) && methods.includes(v.method) ? undefined : "Choose pickup or delivery.",
    deliveryNote: validateDeliveryNote(v.deliveryNote),
  }));
  const locked = submitting || savedOrderId !== null;

  const quantity = parseQuantity(form.values.quantity);
  const quantityValid = !validateQuantity(quantity, product.stockQuantity);
  const quote = priced && priced.quantity === quantity && priced.code === code ? priced.quote : null;
  const methodError = form.errors.method;

  /** Asks the server for the price; a rejected code comes back as couponError with the price without it. */
  async function fetchQuote(qty: number, withCode: string | null): Promise<PricedQuote | null> {
    const res = await quoteOrder({
      items: [{ productId: product.id, quantity: qty }],
      ...(withCode ? { couponCode: withCode } : {}),
    });
    if (!res.ok) {
      setQuoteError(res.error);
      if (res.fieldErrors?.couponCode) {
        setCode(null);
        setCouponError(res.fieldErrors.couponCode);
      }
      return null;
    }
    setQuoteError(null);
    const { quote: q } = res.data;
    const accepted = withCode && q.couponError ? null : withCode;
    if (withCode && q.couponError) {
      setCode(null);
      setCouponError(q.couponError);
    }
    const next = { quantity: qty, code: accepted, quote: q };
    setPriced(next);
    return next;
  }

  // re-price when the quantity or the applied code changes
  useEffect(() => {
    if (product.own || product.stockQuantity === 0 || !quantityValid || locked) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) void fetchQuote(quantity, code);
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // fetchQuote only reads values that are already dependencies
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantity, quantityValid, code, product.id]);

  async function applyCoupon() {
    const entered = normalizeCouponCode(couponInput);
    if (!entered) {
      setCouponError("Enter a code.");
      return;
    }
    if (!quantityValid || applying) return;
    setApplying(true);
    setCouponError(null);
    const result = await fetchQuote(quantity, entered);
    setApplying(false);
    if (result?.code === entered) setCode(entered);
  }

  function removeCoupon() {
    setCode(null);
    setCouponInput("");
    setCouponError(null);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitting || !isFulfillmentMethod(values.method)) return;
    const qty = parseQuantity(values.quantity);
    setSubmitting(true);
    setFormError(null);

    // price it again now; if it moved since the buyer looked, show the new total instead of charging it
    const shown = quote;
    const fresh = await fetchQuote(qty, code);
    if (!fresh || fresh.code !== code) {
      setSubmitting(false);
      return;
    }
    if (!shown || shown.totalKobo !== fresh.quote.totalKobo) {
      setSubmitting(false);
      setFormError(`The price changed. The total is now ${formatKobo(fresh.quote.totalKobo)}. Check it and place the order again.`);
      return;
    }

    const placed = await placeOrder({
      items: [{ productId: product.id, quantity: qty }],
      fulfillmentMethod: values.method,
      deliveryNote: cleanText(values.deliveryNote, true),
      idempotencyKey,
      expectedTotalKobo: fresh.quote.totalKobo,
      ...(code ? { couponCode: code } : {}),
    });
    if (!placed.ok) {
      setSubmitting(false);
      setFormError(placed.error);
      if (placed.fieldErrors?.fulfillmentMethod) form.setServerErrors({ method: placed.fieldErrors.fulfillmentMethod });
      const codeRefused = Boolean(placed.fieldErrors?.couponCode);
      if (codeRefused) {
        setCode(null);
        setCouponError(placed.fieldErrors?.couponCode ?? null);
      }
      // whatever changed, show the current price before another try
      setPriced(null);
      void fetchQuote(qty, codeRefused ? null : code);
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

      <div className="space-y-1.5">
        <label htmlFor="buy-coupon" className="block text-sm font-medium">
          Coupon code (optional)
        </label>
        {code ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-foreground/8">
            <span className="text-sm">
              <span className="font-semibold">{code}</span> applied
            </span>
            <Button type="button" variant="ghost" className="h-auto w-auto px-2 py-1 text-sm" onClick={removeCoupon} disabled={locked}>
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              id="buy-coupon"
              value={couponInput}
              onChange={(e) => {
                setCouponInput(e.target.value);
                setCouponError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void applyCoupon();
                }
              }}
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={30}
              disabled={locked || applying}
              aria-invalid={couponError ? true : undefined}
              aria-describedby={couponError ? "buy-coupon-error" : undefined}
              placeholder="Enter a code"
              className="h-12 min-w-0 flex-1 rounded-2xl bg-white px-4 text-base ring-1 ring-foreground/10 outline-none focus:ring-2 focus:ring-accent"
            />
            <Button
              type="button"
              variant="outline"
              className="w-auto shrink-0 px-5"
              loading={applying}
              disabled={locked || !quantityValid}
              onClick={applyCoupon}
            >
              Apply
            </Button>
          </div>
        )}
        {couponError && (
          <p id="buy-coupon-error" role="alert" className="text-xs text-red-600">
            {couponError}
          </p>
        )}
      </div>

      <dl className="space-y-1.5 rounded-2xl bg-white px-4 py-3 ring-1 ring-foreground/8" aria-live="polite">
        {quote?.promotion && (
          <>
            <div className="flex justify-between text-sm">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular-nums">{formatKobo(quote.subtotalKobo)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-sm text-primary">
              <dt>
                {quote.promotion.code ? `Code ${quote.promotion.code}` : quote.promotion.name}
                <span className="block text-xs text-muted-foreground">
                  Seller&rsquo;s discount on {formatKobo(quote.promotion.eligibleSubtotalKobo)} of products
                </span>
              </dt>
              <dd className="tabular-nums">−{formatKobo(quote.discountKobo)}</dd>
            </div>
          </>
        )}
        <div className="flex items-center justify-between">
          <dt className="text-sm text-muted-foreground">Total to pay</dt>
          <dd className="text-lg font-semibold tabular-nums">{quote && quantityValid ? formatKobo(quote.totalKobo) : "—"}</dd>
        </div>
      </dl>
      {quoteError && <FormAlert>{quoteError}</FormAlert>}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {NO_DELIVERY_FEE_NOTICE} No tax is added. One offer per order. Your order holds the stock and this price for 30
        minutes while you pay with Paystack.
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
        <Button type="submit" loading={submitting} disabled={applying}>
          {submitting ? "Starting payment…" : "Order and pay"}
        </Button>
      )}
    </form>
  );
}
