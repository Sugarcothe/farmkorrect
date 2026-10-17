"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { backButtonClass, ProfileTopBar } from "@/components/profile/profile-parts";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { isNigerianState, NIGERIAN_STATES } from "@/lib/locations/nigeria";
import { archiveProduct, createProduct, updateProduct, uploadProductPhoto, type ProductUpdateRequest } from "@/lib/orders/api";
import {
  DEFAULT_FULFILLMENT,
  FULFILLMENT_LIMITS,
  PRODUCT_CATEGORIES,
  PRODUCT_LIMITS,
  PRODUCT_UNITS,
  type Product,
  type ProductFields,
} from "@/lib/orders/types";
import {
  validateDeliveryAreas,
  validateDeliveryInstructions,
  validateDeliveryTiming,
  validateFulfillmentMethods,
  validatePickupInstructions,
  validatePriceKobo,
  validateProductArea,
  validateProductCategory,
  validateProductDescription,
  validateProductName,
  validateProductUnit,
  validateStockQuantity,
} from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";
import { useForm } from "@/lib/use-form";
import { formatKobo, koboToInput, parseNairaToKobo } from "@/lib/wallet/money";
import { PhotoManager, PhotoQueue, type QueuedPhoto } from "./product-photos";

type Values = {
  name: string;
  category: string;
  description: string;
  unit: string;
  price: string;
  stock: string;
  active: boolean;
  /** a state value, NO_STATE, or "" when nothing was chosen */
  state: string;
  area: string;
  pickup: boolean;
  pickupInstructions: string;
  delivery: boolean;
  deliveryAreas: string;
  deliveryTiming: string;
  deliveryInstructions: string;
};

const NO_STATE = "none";
const STATE_OPTIONS = [{ value: NO_STATE, label: "Not specified" }, ...NIGERIAN_STATES];

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
  state: "state",
  area: "area",
  fulfillment: "pickup",
  "fulfillment.pickup": "pickup",
  "fulfillment.pickup.instructions": "pickupInstructions",
  "fulfillment.delivery": "delivery",
  "fulfillment.delivery.areas": "deliveryAreas",
  "fulfillment.delivery.timing": "deliveryTiming",
  "fulfillment.delivery.instructions": "deliveryInstructions",
};

function initialValues(product?: Product): Values {
  const f = product?.fulfillment ?? DEFAULT_FULFILLMENT;
  const fulfillment = {
    pickup: f.pickup.enabled,
    pickupInstructions: f.pickup.instructions,
    delivery: f.delivery.enabled,
    deliveryAreas: f.delivery.areas,
    deliveryTiming: f.delivery.timing,
    deliveryInstructions: f.delivery.instructions,
  };
  if (!product)
    return {
      name: "",
      category: "",
      description: "",
      unit: "",
      price: "",
      stock: "",
      active: true,
      state: "",
      area: "",
      ...fulfillment,
    };
  return {
    ...fulfillment,
    name: product.name,
    category: product.category,
    description: product.description,
    unit: product.unit,
    price: koboToInput(product.priceKobo),
    stock: String(product.stockQuantity),
    active: product.active,
    state: product.state ?? "",
    area: product.area,
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
    state: isNigerianState(v.state) ? v.state : null,
    area: cleanText(v.area),
    fulfillment: {
      pickup: { enabled: v.pickup, instructions: cleanText(v.pickupInstructions, true) },
      delivery: {
        enabled: v.delivery,
        areas: cleanText(v.deliveryAreas),
        timing: cleanText(v.deliveryTiming),
        instructions: cleanText(v.deliveryInstructions, true),
      },
    },
  };
}

/**
 * Adds a listing, or edits one when `product` is given. The server decides
 * whose listing it is from the session and checks every value again; a new
 * stock count is sent with the count shown here, so it can't silently undo
 * an order placed meanwhile.
 */
export function ProductForm({ product, photoNotice }: { product?: Product; photoNotice?: string }) {
  const router = useRouter();
  const editing = product !== undefined;
  const [initial] = useState(() => initialValues(product));
  const [submitting, setSubmitting] = useState(false);
  const [uploadStep, setUploadStep] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** a new listing's photos, waiting for it to be saved */
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  /** an existing listing's photo upload or change is in progress */
  const [photosBusy, setPhotosBusy] = useState(false);
  const onPhotosBusy = useCallback((value: boolean) => setPhotosBusy(value), []);
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
      area: validateProductArea(v.area),
      pickup: validateFulfillmentMethods(v.pickup, v.delivery),
      pickupInstructions: validatePickupInstructions(v.pickupInstructions),
      deliveryAreas: validateDeliveryAreas(v.deliveryAreas, v.delivery),
      deliveryTiming: validateDeliveryTiming(v.deliveryTiming),
      deliveryInstructions: validateDeliveryInstructions(v.deliveryInstructions),
    };
  });

  function changes(values: Values): ProductUpdateRequest {
    const next = toFields(values);
    if (!editing) return next;
    const before = toFields(initial);
    const changed: ProductUpdateRequest = Object.fromEntries(
      (Object.keys(next) as Array<keyof ProductFields>)
        .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(before[key]))
        .map((key) => [key, next[key]]),
    );
    if (changed.stockQuantity !== undefined) changed.expectedStockQuantity = product.stockQuantity;
    return changed;
  }

  const dirty = editing
    ? Object.keys(changes(form.values)).length > 0
    : JSON.stringify(form.values) !== JSON.stringify(initial) || queue.length > 0;
  // unsaved edits, or photos still on their way
  const unsaved = (dirty && !busy) || photosBusy;

  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function leave() {
    if (busy) return;
    if (photosBusy && !window.confirm("A photo is still uploading. Leave anyway?")) return;
    if (dirty && !window.confirm(DISCARD_MESSAGE)) return;
    router.push(LIST_PATH);
  }

  /**
   * Uploads a new listing's queued photos, main one first, one at a time.
   * Returns how many failed.
   */
  async function uploadQueue(productId: string): Promise<number> {
    let failed = 0;
    for (const [i, photo] of queue.entries()) {
      setUploadStep(`Uploading photo ${i + 1} of ${queue.length}…`);
      setQueue((q) => q.map((p) => (p.key === photo.key ? { ...p, status: "uploading", progress: 0 } : p)));
      const res = await uploadProductPhoto(productId, photo.file, (progress) =>
        setQueue((q) => q.map((p) => (p.key === photo.key ? { ...p, progress } : p))),
      );
      if (!res.ok) failed++;
      setQueue((q) =>
        q.map((p) => (p.key === photo.key ? { ...p, status: res.ok ? "waiting" : "failed", error: res.ok ? undefined : res.error } : p)),
      );
    }
    return failed;
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
    if (!editing && queue.length) {
      // the listing exists now; photos that didn't make it can be added from its edit page
      const failed = await uploadQueue(res.data.product.id);
      if (failed) {
        router.push(`${LIST_PATH}/${res.data.product.id}/edit?photos=failed&count=${failed}`);
        router.refresh();
        return;
      }
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
          {editing ? (
            <PhotoManager productId={product.id} initial={product.images} notice={photoNotice} onBusy={onPhotosBusy} />
          ) : (
            <PhotoQueue queue={queue} onChange={setQueue} disabled={busy} />
          )}
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
          <SelectField
            label="State"
            placeholder="Where is it? (optional)"
            options={STATE_OPTIONS}
            hint="Where the produce is, or is picked up from. Buyers can filter the Market by state."
            {...form.field("state")}
          />
          <TextField
            label="Town or area (optional)"
            placeholder="e.g. Nsukka"
            maxLength={PRODUCT_LIMITS.area.max + 20}
            {...form.field("area")}
          />
          <TextAreaField
            label="Description (optional)"
            placeholder="Breed, size, age, pickup area…"
            maxLength={PRODUCT_LIMITS.description.max + 50}
            hint={`${cleanText(form.values.description, true).length}/${PRODUCT_LIMITS.description.max} characters`}
            {...form.field("description")}
          />
          <fieldset className="space-y-3 rounded-2xl bg-white px-4 py-3.5 ring-1 ring-foreground/8">
            <legend className="sr-only">Pickup and delivery</legend>
            <p className="text-sm font-semibold" aria-hidden="true">
              Pickup &amp; delivery
            </p>
            <Switch
              label="Buyers can pick up"
              description="They collect it from you."
              checked={form.values.pickup}
              onChange={(checked) => form.setValue("pickup", checked)}
              disabled={busy}
            />
            {form.values.pickup && (
              <TextAreaField
                label="Pickup instructions (optional)"
                placeholder="e.g. Farm gate, Opi road. Weekdays 8am to 5pm."
                maxLength={FULFILLMENT_LIMITS.instructions.max + 50}
                {...form.field("pickupInstructions")}
              />
            )}
            <Switch
              label="You deliver"
              description="You arrange delivery yourself; there's no courier."
              checked={form.values.delivery}
              onChange={(checked) => form.setValue("delivery", checked)}
              disabled={busy}
            />
            {form.values.delivery && (
              <>
                <TextField
                  label="Areas you deliver to"
                  placeholder="e.g. Nsukka town and UNN campus"
                  maxLength={FULFILLMENT_LIMITS.areas.max + 20}
                  {...form.field("deliveryAreas")}
                />
                <TextField
                  label="Timing (optional)"
                  placeholder="e.g. Within 2 days of payment"
                  maxLength={FULFILLMENT_LIMITS.timing.max + 20}
                  {...form.field("deliveryTiming")}
                />
                <TextAreaField
                  label="Delivery instructions (optional)"
                  placeholder="e.g. I'll call before I set out."
                  maxLength={FULFILLMENT_LIMITS.instructions.max + 50}
                  {...form.field("deliveryInstructions")}
                />
              </>
            )}
            {form.errors.pickup && (
              <p role="alert" className="text-xs text-red-600">
                {form.errors.pickup}
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Farm Korret doesn&rsquo;t calculate or collect delivery fees: buyers pay only the product price. Any delivery
              charge is agreed directly between you and the buyer.
            </p>
          </fieldset>
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
              {submitting ? (uploadStep ?? "Saving…") : editing ? "Save" : "List Product"}
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
