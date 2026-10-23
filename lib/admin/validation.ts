import { cleanText } from "@/lib/profile/validation";
import { ADMIN_TEXT_LIMITS } from "./types";

// Checks for the text admins type, shared by the forms and the API (the API
// always re-checks). Returns an error message, or undefined when it's fine.

function validateText(value: string, limits: { min: number; max: number }, empty: string) {
  const text = cleanText(value, true);
  if (!text) return empty;
  if (text.length < limits.min) return `Add a little more detail (at least ${limits.min} characters).`;
  if (text.length > limits.max) return `Keep it to ${limits.max} characters or fewer.`;
}

export function validateAdminReason(value: string) {
  return validateText(value, ADMIN_TEXT_LIMITS.reason, "Give a reason.");
}

export function validateResolutionNote(value: string) {
  return validateText(value, ADMIN_TEXT_LIMITS.resolutionNote, "Write an internal note on how this was resolved.");
}

export function validateLimitedText(value: string, limits: { min: number; max: number }, empty: string) {
  return validateText(value, limits, empty);
}
