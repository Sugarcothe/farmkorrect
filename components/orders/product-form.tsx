"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { backButtonClass, ProfileTopBar } from "@/components/profile/profile-parts";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { archiveProduct, createProduct, updateProduct, type ProductUpdateRequest } from "@/lib/orders/api";
import { PRODUCT_CATEGORIES, PRODUCT_LIMITS, PRODUCT_UNITS, type Product, type ProductFields } from "@/lib/orders/types";
import {
  validatePriceKobo,
  validateProductCategory,
  validateProductDescription,
  validateProductName,
  validateProductUnit,
  validateStockQuantity,
} from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";
import { useForm } from "@/lib/use-form";
import { formatKobo, koboToInput, parseNairaToKobo } from "@/lib/wallet/money";

type Values = {
  name: string;
  category: string;
  description: string;
  unit: string;
  price: string;
  stock: string;
  active: boolean;
};

const LIST_PATH = "/market/listings";
const DISCARD_MESSAGE = "Discard your unsaved changes?";

const FORM_FIELD: Record<string, keyof Values> = {
  name: "name",
  category: "category",
  description: "description",
  unit: "unit",
  priceKobo: "price",
  stockQuantity: "stock",
  active: "active",
};

function initialValues(product?: Product): Values {
  if (!product) return { name: "", category: "", description: "", unit: "", price: "", stock: "", active: true };
  return {
    name: product.name,
    category: product.category,
    description: product.description,
    unit: product.unit,
    price: koboToInput(product.priceKobo),
    stock: String(product.stockQuantity),
    active: product.active,
  };
}

const parseStock = (value: string) => (/^\d{1,7}$/.test(value.trim()) ? Number(value.trim()) : NaN);

function toFields(v: Values): ProductFields {
  return {
    name: cleanText(v.name),
    category: v.category as ProductFields["category"],
    description: cleanText(v.description, true),
    unit: v.unit as ProductFields["unit"],
    priceKobo: parseNairaToKobo(v.price) ?? NaN,
    stockQuantity: parseStock(v.stock),
    active: v.active,
  };
}

/**
 * Adds a listing, or edits one when `product` is given. The server decides
 * whose listing it is from the session and checks every value again; a new
 * stock count is sent with the count shown here, so it can't silently undo
 * an order placed meanwhile.
 */
export function ProductForm({ product }: { product?: Product }) {
  const router = useRouter();
  const editing = product !== undefined;
  const [initial] = useState(() => initialValues(product));
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const busy = submitting || removing;

  const form = useForm<Values>(initial, (v) => {
    const price = parseNairaToKobo(v.price);
    return {
      name: validateProductName(v.name),
      category: validateProductCategory(v.category),
      description: validateProductDescription(v.description),
      unit: validateProductUnit(v.unit),
      price: !v.price.trim()
        ? "Enter a price in naira."
        : price === null
          ? "Enter the price as a number, like 4500."
          : validatePriceKobo(price),
      stock: !v.stock.trim() ? "Enter how many you have." : validateStockQuantity(parseStock(v.stock)),
    };
  });

  function changes(values: Values): ProductUpdateRequest {
    const next = toFields(values);
    if (!editing) return next;
    const before = toFields(initial);
    const changed: ProductUpdateRequest = Object.fromEntries(
      (Object.keys(next) as Array<keyof ProductFields>).filter((key) => next[key] !== before[key]).map((key) => [key, next[key]]),
    );
    if (changed.stockQuantity !== undefined) changed.expectedStockQuantity = product.stockQuantity;
    return changed;
  }

  const dirty = editing
    ? Object.keys(changes(form.values)).length > 0
    : JSON.stringify(form.values) !== JSON.stringify(initial);

  useEffect(() => {
    if (!dirty || busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  function leave() {
    if (busy) return;
    if (dirty && !window.confirm(DISCARD_MESSAGE)) return;
    router.push(LIST_PATH);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    if (busy || (editing && !dirty)) return;
    setSubmitting(true);
    setFormError(null);
    const res = editing ? await updateProduct(product.id, changes(values)) : await createProduct(toFields(values));
    if (!res.ok) {
      setSubmitting(false);
      setFormError(res.error);
      if (res.fieldErrors)
        form.setServerErrors(
          Object.fromEntries(
            Object.entries(res.fieldErrors)
              .filter(([key]) => key in FORM_FIELD)
              .map(([key, message]) => [FORM_FIELD[key], message]),
          ),
        );
      return;
    }
    router.push(`${LIST_PATH}?saved=${editing ? "updated" : "added"}`);
    router.refresh();
  });

  async function remove() {
    if (!editing || busy) return;
    if (!window.confirm("Remove this listing from the Market? Orders already placed aren't affected.")) return;
    setRemoving(true);
    setFormError(null);
    const res = await archiveProduct(product.id);
    if (!res.ok) {
      setRemoving(false);
      setFormError(res.error);
      return;
    }
    router.push(`${LIST_PATH}?saved=removed`);
    router.refresh();
  }

  const price = parseNairaToKobo(form.values.price);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar
        title={editing ? "Edit Listing" : "New Listing"}
        back={
          <button type="button" aria-label="Back" onClick={leave} className={backButtonClass}>
            <Icon name="arrow-left" />
          </button>
        }
      />

      <form onSubmit={onSubmit} noValidate className="flex flex-1 flex-col px-5 pb-6">
        <div className="space-y-4">
          <TextField label="Product Name" placeholder="e.g. Fresh layer eggs" maxLength={PRODUCT_LIMITS.name.max + 20} {...form.field("name")} />
          <SelectField label="Category" placeholder="Select a category" options={PRODUCT_CATEGORIES} {...form.field("category")} />
          <SelectField label="Sold" placeholder="Select how it's sold" options={PRODUCT_UNITS} {...form.field("unit")} />
          <TextField
            label="Price (₦)"
            inputMode="decimal"
            placeholder="e.g. 4,500"
            hint={price !== null && !form.errors.price ? `Buyers will see ${formatKobo(price)}.` : "Per unit, in naira."}
            {...form.field("price")}
          />
          <TextField
            label="In stock"
            inputMode="numeric"
            placeholder="e.g. 20"
            hint={editing ? "Orders reduce this automatically; cancelled unpaid orders add it back." : "How many you can sell now."}
            {...form.field("stock")}
          />
          <TextAreaField
            label="Description (optional)"
            placeholder="Breed, size, age, pickup area…"
            maxLength={PRODUCT_LIMITS.description.max + 50}
            hint={`${cleanText(form.values.description, true).length}/${PRODUCT_LIMITS.description.max} characters`}
            {...form.field("description")}
          />
          <div className="rounded-2xl bg-white px-4 py-3.5 ring-1 ring-foreground/8">
            <Switch
              label="Show in the Market"
              description="Turn off to hide this listing without removing it."
              checked={form.values.active}
              onChange={(checked) => form.setValue("active", checked)}
              disabled={busy}
            />
          </div>
        </div>

        {formError && (
          <div className="mt-5">
            <FormAlert>{formError}</FormAlert>
          </div>
        )}

        <div className="mt-auto pt-6">
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" onClick={leave} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={(editing && !dirty) || removing}>
              {submitting ? "Saving…" : editing ? "Save" : "List Product"}
            </Button>
          </div>
          {editing && (
            <Button type="button" variant="ghost" className="mt-2 text-red-600 hover:text-red-700" loading={removing} disabled={submitting} onClick={remove}>
              {removing ? "Removing…" : "Remove listing"}
            </Button>
          )}
        </div>
      </form>
    </main>
  );
}
