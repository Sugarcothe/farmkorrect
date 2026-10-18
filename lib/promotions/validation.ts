import { cleanText } from "@/lib/profile/validation";
import { formatKobo, isKobo } from "@/lib/wallet/money";
import { COUPON_CODE, normalizeCouponCode, PROMOTION_LIMITS, type PromotionType } from "./types";

// Pure validators for promotions; each returns an error message, or
// undefined when valid. The seller's form runs them as they type and the
// API runs them again on every save.

const DAY_MS = 24 * 60 * 60_000;

export function validatePromotionName(value: string) {
  const name = cleanText(value);
  const { min, max } = PROMOTION_LIMITS.name;
  if (!name) return "Give this promotion a name buyers will see.";
  if (name.length < min) return `Use at least ${min} characters.`;
  if (name.length > max) return `Keep the name to ${max} characters or fewer.`;
}

export function validatePromotionDescription(value: string) {
  if (cleanText(value, true).length > PROMOTION_LIMITS.description.max)
    return `Keep the description to ${PROMOTION_LIMITS.description.max} characters or fewer.`;
}

export function isPromotionType(value: unknown): value is PromotionType {
  return value === "percentage" || value === "fixed";
}

/** A whole percent from 1 to 90, or a fixed amount of at least ₦1. */
export function validatePromotionValue(type: PromotionType, value: number) {
  if (type === "percentage") {
    const { min, max } = PROMOTION_LIMITS.percent;
    if (!Number.isSafeInteger(value) || value < min || value > max) return `Enter a whole percentage from ${min} to ${max}.`;
    return;
  }
  const { min, max } = PROMOTION_LIMITS.fixedKobo;
  if (!isKobo(value) || value < min) return `Enter an amount of at least ${formatKobo(min)}.`;
  if (value > max) return `Enter an amount up to ${formatKobo(max)}.`;
}

/** Codes are optional; when given they're checked in their normalized form. */
export function validateCouponCode(value: string) {
  const code = normalizeCouponCode(value);
  if (!code) return;
  const { min, max } = PROMOTION_LIMITS.code;
  if (code.length < min || code.length > max) return `Use ${min} to ${max} letters or numbers.`;
  if (!COUPON_CODE.test(code)) return "Use letters and numbers only (a hyphen between them is fine).";
}

export function validatePromotionDates(startsAt: Date | null, endsAt: Date | null, now = new Date()) {
  const errors: { startsAt?: string; endsAt?: string } = {};
  if (!startsAt || Number.isNaN(startsAt.getTime())) errors.startsAt = "Choose when the promotion starts.";
  else if (startsAt.getTime() > now.getTime() + PROMOTION_LIMITS.maxLeadDays * DAY_MS)
    errors.startsAt = "Start within the next year.";
  if (!endsAt || Number.isNaN(endsAt.getTime())) errors.endsAt = "Choose when the promotion ends.";
  else if (endsAt.getTime() <= now.getTime()) errors.endsAt = "Choose an end time in the future.";
  else if (startsAt && !Number.isNaN(startsAt.getTime())) {
    if (endsAt.getTime() <= startsAt.getTime()) errors.endsAt = "End the promotion after it starts.";
    else if (endsAt.getTime() - startsAt.getTime() > PROMOTION_LIMITS.maxDays * DAY_MS)
      errors.endsAt = `A promotion can run for up to ${PROMOTION_LIMITS.maxDays} days.`;
  }
  return errors;
}

/** An optional amount; null means "no minimum" / "no cap". */
export function validateOptionalKobo(value: number | null, label: string) {
  if (value === null) return;
  if (!isKobo(value) || value < 100) return `Enter ${label} of at least ₦1, or leave it empty.`;
}

export function validateUseLimit(value: number | null, max: number) {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return `Enter a number from 1 to ${max.toLocaleString("en-NG")}, or leave it empty.`;
}
