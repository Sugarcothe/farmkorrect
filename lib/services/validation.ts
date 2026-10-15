import type { Role } from "@/lib/auth/types";
import { cleanText } from "@/lib/profile/validation";
import { isListedDuration, SERVICE_LIMITS, serviceCategory } from "./config";

// Pure validators for a service; each returns an error message, or undefined
// when valid. The form runs them as the user types and the API runs them
// again on every request.

export function validateServiceName(value: string) {
  const name = cleanText(value);
  const { min, max } = SERVICE_LIMITS.name;
  if (!name) return "Enter a name for this service.";
  if (name.length < min) return `Use at least ${min} characters.`;
  if (name.length > max) return `Keep the name to ${max} characters or fewer.`;
}

export function validateServiceDescription(value: string) {
  const description = cleanText(value, true);
  const { min, max } = SERVICE_LIMITS.description;
  if (!description) return "Describe what this service includes.";
  if (description.length < min) return `Add a little more detail (at least ${min} characters).`;
  if (description.length > max) return `Keep the description to ${max} characters or fewer.`;
}

export function validateServiceCategory(role: Role, value: string) {
  if (!value) return "Choose a category.";
  if (!serviceCategory(role, value)) return "Choose one of the listed categories.";
}

/** A price already parsed to a number; `category` decides whether ₦0 is allowed. */
export function validatePriceNgn(role: Role, value: number, category: string) {
  if (!Number.isFinite(value)) return "Enter a price in naira.";
  if (value < 0) return "The price can't be negative.";
  if (!Number.isInteger(value)) return "Enter the price in whole naira, without kobo.";
  if (value > SERVICE_LIMITS.maxPriceNgn) return "That price is higher than we allow. Check the amount.";
  if (value === 0 && serviceCategory(role, category)?.allowsFree === false)
    return "This kind of service can't be listed as free. Enter a price.";
}

export function validateDurationMinutes(value: number | null) {
  if (value !== null && !isListedDuration(value)) return "Choose one of the listed durations.";
}

/**
 * Reads what was typed in the price box: "5000", "5,000" or "₦5,000". Returns
 * NaN for anything else (including negatives and decimals, which the
 * validator then explains), never a silently "fixed" number.
 */
export function parsePriceInput(value: string): number {
  const compact = value.replace(/[\s,₦]/g, "");
  if (!compact) return NaN;
  if (/^-\d+(\.\d+)?$/.test(compact) || /^\d+\.\d+$/.test(compact)) return Number(compact);
  return /^\d+$/.test(compact) ? Number(compact) : NaN;
}
