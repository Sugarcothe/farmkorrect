"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { backButtonClass, ProfileTopBar } from "@/components/profile/profile-parts";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { createPromotion, updatePromotion } from "@/lib/promotions/api";
import { applyPromotion, isDiscount } from "@/lib/promotions/pricing";
import {
  normalizeCouponCode,
  PROMOTION_LIMITS,
  PROMOTION_TYPES,
  type Promotion,
  type PromotionFields,
  type PromotionType,
} from "@/lib/promotions/types";
import {
  isPromotionType,
  validateCouponCode,
  validateOptionalKobo,
  validatePromotionDates,
  validatePromotionDescription,
  validatePromotionName,
  validatePromotionValue,
  validateUseLimit,
} from "@/lib/promotions/validation";
import { cleanText } from "@/lib/profile/validation";
import { useForm } from "@/lib/use-form";
import { formatKobo, koboToInput, parseNairaToKobo } from "@/lib/wallet/money";
import { termsOf, TermsList } from "./promotion-parts";

export type PromotionProductOption = { id: string; name: string; priceKobo: number };

type Values = {
  name: string;
  description: string;
  type: string;
  value: string;
  /** "all" or "products" */
  scope: string;
  code: string;
  /** datetime-local values, in the device's time */
  startsAt: string;
  endsAt: string;
  minOrder: string;
  maxDiscount: string;
  totalLimit: string;
  perBuyerLimit: string;
};

const LIST_PATH = "/market/promotions";
const DISCARD_MESSAGE = "Discard your unsaved changes?";

const SCOPES = [
  { value: "all", label: "All my products" },
  { value: "products", label: "Only the products I pick" },
];

const FORM_FIELD: Record<string, keyof Values> = {
  name: "name",
  description: "description",
  type: "type",
  value: "value",
  scope: "scope",
  code: "code",
  startsAt: "startsAt",
  endsAt: "endsAt",
  minOrderKobo: "minOrder",
  maxDiscountKobo: "maxDiscount",
  totalLimit: "totalLimit",
  perBuyerLimit: "perBuyerLimit",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO time as a datetime-local value in the device's time zone. */
function toLocalInput(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (device time) as a Date, or null. */
function fromLocalInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "" → null; whole numbers only, else NaN so validation reports it. */
const parseCount = (value: string) => (!value.trim() ? null : /^\d{1,7}$/.test(value.trim()) ? Number(value.trim()) : NaN);
const parseOptionalNaira = (value: string) => (!value.trim() ? null : (parseNairaToKobo(value) ?? NaN));

function parseValue(type: string, value: string) {
  if (type === "fixed") return parseNairaToKobo(value) ?? NaN;
  return /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : NaN;
}

function initialValues(promotion?: Promotion): Values {
  if (!promotion) {
    const start = new Date();
    start.setSeconds(0, 0);
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60_000);
    return {
      name: "",
      description: "",
      type: "percentage",
      value: "",
      scope: "all",
      code: "",
      startsAt: toLocalInput(start.toISOString()),
      endsAt: toLocalInput(end.toISOString()),
      minOrder: "",
      maxDiscount: "",
      totalLimit: "",
      perBuyerLimit: "",
    };
  }
  return {
    name: promotion.name,
    description: promotion.description,
    type: promotion.type,
    value: promotion.type === "fixed" ? koboToInput(promotion.value) : String(promotion.value),
    scope: promotion.scope,
    code: promotion.code ?? "",
    startsAt: toLocalInput(promotion.startsAt),
    endsAt: toLocalInput(promotion.endsAt),
    minOrder: promotion.minOrderKobo === null ? "" : koboToInput(promotion.minOrderKobo),
    maxDiscount: promotion.maxDiscountKobo === null ? "" : koboToInput(promotion.maxDiscountKobo),
    totalLimit: promotion.totalLimit === null ? "" : String(promotion.totalLimit),
    perBuyerLimit: promotion.perBuyerLimit === null ? "" : String(promotion.perBuyerLimit),
  };
}

function toFields(v: Values, productIds: string[]): PromotionFields {
  const type = (isPromotionType(v.type) ? v.type : "percentage") as PromotionType;
  return {
    name: cleanText(v.name),
    description: cleanText(v.description, true),
    type,
    value: parseValue(type, v.value),
    scope: v.scope === "products" ? "products" : "all",
    productIds: v.scope === "products" ? productIds : [],
    code: normalizeCouponCode(v.code) || null,
    startsAt: fromLocalInput(v.startsAt)?.toISOString() ?? "",
    endsAt: fromLocalInput(v.endsAt)?.toISOString() ?? "",
    minOrderKobo: parseOptionalNaira(v.minOrder),
    // a cap only means something for a percentage
    maxDiscountKobo: type === "percentage" ? parseOptionalNaira(v.maxDiscount) : null,
    totalLimit: parseCount(v.totalLimit),
    perBuyerLimit: parseCount(v.perBuyerLimit),
  };
}

/**
 * Creates a promotion as a draft, or edits a draft or paused one. The server
 * checks every value again and confirms the products are the seller's own;
 * nothing goes live until the seller activates it from its page.
 */
export function PromotionForm({ promotion, products }: { promotion?: Promotion; products: PromotionProductOption[] }) {
  const router = useRouter();
  const editing = promotion !== undefined;
  const [initial] = useState(() => initialValues(promotion));
  const [initialIds] = useState(() => promotion?.productIds ?? []);
  const [productIds, setProductIds] = useState<string[]>(initialIds);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>(initial, (v) => {
    const type = isPromotionType(v.type) ? v.type : null;
    const dates = validatePromotionDates(fromLocalInput(v.startsAt), fromLocalInput(v.endsAt));
    const total = parseCount(v.totalLimit);
    const perBuyer = parseCount(v.perBuyerLimit);
    return {
      name: validatePromotionName(v.name),
      description: validatePromotionDescription(v.description),
      type: type ? undefined : "Choose a percentage or an amount off.",
      value: !v.value.trim()
        ? "Enter how much to take off."
        : type
          ? validatePromotionValue(type, parseValue(type, v.value))
          : undefined,
      code: validateCouponCode(v.code),
      startsAt: dates.startsAt,
      endsAt: dates.endsAt,
      minOrder: validateOptionalKobo(parseOptionalNaira(v.minOrder), "a minimum"),
      maxDiscount: type === "percentage" ? validateOptionalKobo(parseOptionalNaira(v.maxDiscount), "a cap") : undefined,
      totalLimit: validateUseLimit(total, PROMOTION_LIMITS.totalLimit.max),
      perBuyerLimit:
        validateUseLimit(perBuyer, PROMOTION_LIMITS.perBuyerLimit.max) ??
        (total !== null && perBuyer !== null && perBuyer > total ? "Can't be more than the total limit." : undefined),
    };
  });

  const fields = toFields(form.values, productIds);
  const dirty =
    JSON.stringify(form.values) !== JSON.stringify(initial) ||
    JSON.stringify([...productIds].sort()) !== JSON.stringify([...initialIds].sort());

  useEffect(() => {
    if (!dirty || submitting) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, submitting]);

  function leave() {
    if (submitting) return;
    if (dirty && !window.confirm(DISCARD_MESSAGE)) return;
    router.push(editing ? `${LIST_PATH}/${promotion.id}` : LIST_PATH);
  }

  function toggleProduct(id: string, on: boolean) {
    setProductsError(null);
    setProductIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  }

  const productsMissing = form.values.scope === "products" && productIds.length === 0;

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitting || (editing && !dirty)) return;
    if (productsMissing) {
      setProductsError("Choose at least one of your products.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const body = toFields(values, productIds);
    const res = editing ? await updatePromotion(promotion.id, body, promotion.version) : await createPromotion(body);
    if (!res.ok) {
      setSubmitting(false);
      setFormError(res.error);
      if (res.fieldErrors) {
        if (res.fieldErrors.productIds) setProductsError(res.fieldErrors.productIds);
        form.setServerErrors(
          Object.fromEntries(
            Object.entries(res.fieldErrors)
              .filter(([key]) => key in FORM_FIELD)
              .map(([key, message]) => [FORM_FIELD[key], message]),
          ),
        );
      }
      return;
    }
    router.push(`${LIST_PATH}/${res.data.promotion.id}?saved=${editing ? "updated" : "created"}`);
    router.refresh();
  });

  const percentage = form.values.type === "percentage";
  const previewProducts = (form.values.scope === "products" ? products.filter((p) => productIds.includes(p.id)) : products).slice(0, 3);
  const valid = Number.isFinite(fields.value) && !validatePromotionValue(fields.type, fields.value);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar
        title={editing ? "Edit Promotion" : "New Promotion"}
        back={
          <button type="button" aria-label="Back" onClick={leave} className={backButtonClass}>
            <Icon name="arrow-left" />
          </button>
        }
      />

      <form onSubmit={onSubmit} noValidate className="flex flex-1 flex-col px-5 pb-6">
        <div className="space-y-4">
          <TextField
            label="Promotion name"
            placeholder="e.g. Harvest week sale"
            maxLength={PROMOTION_LIMITS.name.max + 20}
            hint="Buyers see this at checkout and on their order."
            {...form.field("name")}
          />
          <TextAreaField
            label="Description (optional)"
            placeholder="For your own notes, or a line about the offer"
            maxLength={PROMOTION_LIMITS.description.max + 50}
            {...form.field("description")}
          />
          <SelectField label="Discount" placeholder="Choose a discount type" options={PROMOTION_TYPES} {...form.field("type")} />
          <TextField
            label={percentage ? "Percentage off" : "Amount off (₦)"}
            inputMode={percentage ? "numeric" : "decimal"}
            placeholder={percentage ? "e.g. 10" : "e.g. 500"}
            hint={
              percentage
                ? `A whole number from ${PROMOTION_LIMITS.percent.min} to ${PROMOTION_LIMITS.percent.max}.`
                : "Taken off the order once, never more than the products it covers."
            }
            {...form.field("value")}
          />
          <SelectField label="Applies to" placeholder="Choose products" options={SCOPES} {...form.field("scope")} />
          {form.values.scope === "products" && (
            <fieldset className="space-y-2 rounded-2xl bg-white px-4 py-3.5 ring-1 ring-foreground/8">
              <legend className="sr-only">Products</legend>
              <p className="text-sm font-semibold" aria-hidden="true">
                Products ({productIds.length} chosen)
              </p>
              {products.length === 0 ? (
                <p className="text-sm text-muted-foreground">You have no listings yet. Add one first.</p>
              ) : (
                products.map((p) => (
                  <label key={p.id} className="flex items-center gap-3 py-1 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={productIds.includes(p.id)}
                      disabled={submitting || (!productIds.includes(p.id) && productIds.length >= PROMOTION_LIMITS.products.max)}
                      onChange={(e) => toggleProduct(p.id, e.target.checked)}
                    />
                    <span className="flex-1">{p.name}</span>
                    <span className="text-muted-foreground">{formatKobo(p.priceKobo)}</span>
                  </label>
                ))
              )}
              {productsError && (
                <p role="alert" className="text-xs text-red-600">
                  {productsError}
                </p>
              )}
            </fieldset>
          )}
          <TextField
            label="Coupon code (optional)"
            placeholder="e.g. HARVEST10"
            autoCapitalize="characters"
            maxLength={PROMOTION_LIMITS.code.max + 5}
            hint="Leave empty to apply it automatically. With a code, only buyers who enter it get the discount."
            {...form.field("code")}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Starts" type="datetime-local" {...form.field("startsAt")} />
            <TextField label="Ends" type="datetime-local" {...form.field("endsAt")} />
          </div>
          <TextField
            label="Minimum spend (₦, optional)"
            inputMode="decimal"
            placeholder="No minimum"
            hint="Counted on the products this promotion covers."
            {...form.field("minOrder")}
          />
          {percentage && (
            <TextField
              label="Maximum discount (₦, optional)"
              inputMode="decimal"
              placeholder="No cap"
              {...form.field("maxDiscount")}
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Total uses (optional)" inputMode="numeric" placeholder="Unlimited" {...form.field("totalLimit")} />
            <TextField label="Uses per buyer (optional)" inputMode="numeric" placeholder="Unlimited" {...form.field("perBuyerLimit")} />
          </div>

          <section className="space-y-3 rounded-2xl bg-white px-4 py-3.5 ring-1 ring-foreground/8" aria-label="Preview">
            <p className="text-sm font-semibold">Preview</p>
            {valid ? (
              <>
                <TermsList
                  terms={termsOf({
                    ...fields,
                    startsAt: fields.startsAt || new Date().toISOString(),
                    endsAt: fields.endsAt || new Date().toISOString(),
                    productNames: products.filter((p) => productIds.includes(p.id)).map((p) => p.name),
                  })}
                />
                {previewProducts.length > 0 && (
                  <ul className="space-y-1 border-t border-foreground/8 pt-3 text-sm">
                    {previewProducts.map((p) => {
                      const result = applyPromotion(fields, [{ productId: p.id, lineTotalKobo: p.priceKobo }]);
                      return (
                        <li key={p.id} className="flex justify-between gap-3">
                          <span className="truncate">One {p.name}</span>
                          {isDiscount(result) ? (
                            <span>
                              <s className="text-muted-foreground">{formatKobo(p.priceKobo)}</s>{" "}
                              <strong>{formatKobo(p.priceKobo - result.discountKobo)}</strong>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {result.reason === "below_minimum" ? "Below the minimum" : "No saving"}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  You fund this discount: buyers pay less and your earnings come from what they pay. {editing
                    ? "Saving doesn't change its status."
                    : "It's saved as a draft; buyers see nothing until you activate it."}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Enter the discount to see how it looks.</p>
            )}
          </section>
        </div>

        {formError && (
          <div className="mt-5">
            <FormAlert>{formError}</FormAlert>
          </div>
        )}

        <div className="mt-auto pt-6">
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" onClick={leave} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={editing && !dirty}>
              {submitting ? "Saving…" : editing ? "Save" : "Save draft"}
            </Button>
          </div>
        </div>
      </form>
    </main>
  );
}
