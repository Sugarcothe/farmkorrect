import { cleanText } from "@/lib/profile/validation";
import { REVIEW_LIMITS } from "./types";

// Pure validators for the review form; each returns an error message, or
// undefined when valid. The form runs them as the user types and the API
// runs them again on every request.

export function validateRating(value: unknown) {
  const { min, max } = REVIEW_LIMITS.rating;
  if (value === 0 || value === "" || value === undefined || value === null) return "Choose a star rating.";
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return `Choose a rating from ${min} to ${max} stars.`;
}

export function validateReviewText(value: string) {
  const text = cleanText(value, true);
  const { min, max } = REVIEW_LIMITS.text;
  if (!text) return "Tell other buyers about this product.";
  if (text.length < min) return `Add a little more detail (at least ${min} characters).`;
  if (text.length > max) return `Keep your review to ${max} characters or fewer.`;
}

/** The review text as it's stored: control characters removed and whitespace tidied. */
export const cleanReviewText = (value: string) => cleanText(value, true);
