import { isNigerianState } from "@/lib/locations/nigeria";
import { cleanText } from "@/lib/profile/validation";
import {
  FULFILLMENT_LIMITS,
  FULFILLMENT_METHODS,
  ORDER_LIMITS,
  PRODUCT_CATEGORIES,
  PRODUCT_LIMITS,
  PRODUCT_UNITS,
  type FulfillmentMethod,
  type ProductFulfillment,
} from "./types";

// Pure validators for listings and orders; each returns an error message, or
// undefined when valid. The forms run them as the user types and the API
// runs them again on every request.

export function validateProductName(value: string) {
  const name = cleanText(value);
  const { min, max } = PRODUCT_LIMITS.name;
  if (!name) return "Enter a name for this product.";
  if (name.length < min) return `Use at least ${min} characters.`;
  if (name.length > max) return `Keep the name to ${max} characters or fewer.`;
}

export function validateProductDescription(value: string) {
  if (cleanText(value, true).length > PRODUCT_LIMITS.description.max)
    return `Keep the description to ${PRODUCT_LIMITS.description.max} characters or fewer.`;
}

/** A listing's state is optional; when given it must be one of the listed states. */
export function validateProductState(value: string | null) {
  if (value !== null && value !== "" && !isNigerianState(value)) return "Choose one of the listed states.";
}

export function validateProductArea(value: string) {
  if (cleanText(value).length > PRODUCT_LIMITS.area.max)
    return `Keep the town or area to ${PRODUCT_LIMITS.area.max} characters or fewer.`;
}

export function validateProductCategory(value: string) {
  if (!value) return "Choose a category.";
  if (!PRODUCT_CATEGORIES.some((c) => c.value === value)) return "Choose one of the listed categories.";
}

export function validateProductUnit(value: string) {
  if (!value) return "Choose how it's sold.";
  if (!PRODUCT_UNITS.some((u) => u.value === value)) return "Choose one of the listed units.";
}

/** A price already converted to kobo. */
export function validatePriceKobo(value: number) {
  const { min, max } = PRODUCT_LIMITS.priceKobo;
  if (!Number.isSafeInteger(value)) return "Enter a price in naira, like 4500.";
  if (value < min) return "The price must be at least ₦1.";
  if (value > max) return "That price is higher than we allow. Check the amount.";
}

export function validateStockQuantity(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) return "Enter how many you have, as a whole number.";
  if (value > PRODUCT_LIMITS.stock.max) return `Keep the stock to ${PRODUCT_LIMITS.stock.max.toLocaleString("en-NG")} or fewer.`;
}

// --- fulfilment ---------------------------------------------------------------------

export function validateFulfillmentMethods(pickupEnabled: boolean, deliveryEnabled: boolean) {
  if (!pickupEnabled && !deliveryEnabled) return "Offer pickup, delivery or both.";
}

export function validatePickupInstructions(value: string) {
  if (cleanText(value, true).length > FULFILLMENT_LIMITS.instructions.max)
    return `Keep the pickup instructions to ${FULFILLMENT_LIMITS.instructions.max} characters or fewer.`;
}

/** Areas are only needed while delivery is offered. */
export function validateDeliveryAreas(value: string, deliveryEnabled: boolean) {
  const areas = cleanText(value);
  const { min, max } = FULFILLMENT_LIMITS.areas;
  if (areas.length > max) return `Keep the areas to ${max} characters or fewer.`;
  if (!deliveryEnabled) return;
  if (!areas) return "Say where you deliver to.";
  if (areas.length < min) return `Use at least ${min} characters.`;
}

export function validateDeliveryTiming(value: string) {
  if (cleanText(value).length > FULFILLMENT_LIMITS.timing.max)
    return `Keep the timing to ${FULFILLMENT_LIMITS.timing.max} characters or fewer.`;
}

export function validateDeliveryInstructions(value: string) {
  if (cleanText(value, true).length > FULFILLMENT_LIMITS.instructions.max)
    return `Keep the delivery instructions to ${FULFILLMENT_LIMITS.instructions.max} characters or fewer.`;
}

export const isFulfillmentMethod = (value: unknown): value is FulfillmentMethod =>
  FULFILLMENT_METHODS.some((m) => m.value === value);

/** The methods every one of these products offers (an order uses one method for all of them). */
export function sharedFulfillmentMethods(options: ProductFulfillment[]): FulfillmentMethod[] {
  return FULFILLMENT_METHODS.map((m) => m.value).filter((method) => options.every((o) => o[method].enabled));
}

export function validateQuantity(value: number, available: number) {
  if (!Number.isSafeInteger(value) || value < 1) return "Enter a quantity of at least 1.";
  if (value > ORDER_LIMITS.quantity) return `You can order up to ${ORDER_LIMITS.quantity} at a time.`;
  if (value > available) return available > 0 ? `Only ${available} left.` : "This product is sold out.";
}

function validateNote(value: string, limits: { min: number; max: number }, empty: string) {
  const note = cleanText(value, true);
  if (!note) return empty;
  if (note.length < limits.min) return `Add a little more detail (at least ${limits.min} characters).`;
  if (note.length > limits.max) return `Keep it to ${limits.max} characters or fewer.`;
}

export function validateDeliveryNote(value: string) {
  return validateNote(value, ORDER_LIMITS.deliveryNote, "Tell the seller where and how to deliver.");
}

export function validateIssueNote(value: string) {
  return validateNote(value, ORDER_LIMITS.issueNote, "Describe what went wrong.");
}

export function validateRefundReason(value: string) {
  return validateNote(value, ORDER_LIMITS.refundReason, "Give a reason for the refund.");
}
