import { cleanText } from "@/lib/profile/validation";
import { ORDER_LIMITS, PRODUCT_CATEGORIES, PRODUCT_LIMITS, PRODUCT_UNITS } from "./types";

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
