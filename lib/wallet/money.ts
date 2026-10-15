// Naira amounts are handled as integer kobo everywhere. These helpers convert
// at the edges (display and form input) without floating-point arithmetic.

/** The largest amount the app accepts anywhere: ₦10 billion. */
export const MAX_KOBO = 1_000_000_000_000;

export function isKobo(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_KOBO;
}

const GROUPED = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 });

/** "₦12,345.60"; negative amounts get a leading minus. */
export function formatKobo(kobo: number): string {
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${kobo < 0 ? "−" : ""}₦${GROUPED.format(naira)}.${String(rest).padStart(2, "0")}`;
}

/**
 * Parses what a user typed ("1,500", "1500.5", "₦2,000.00") into kobo, or
 * null if it isn't a plain naira amount with at most two decimal places.
 */
export function parseNairaToKobo(input: string): number | null {
  const cleaned = input.trim().replace(/^₦\s*/, "").replace(/,/g, "");
  const match = cleaned.match(/^(\d{1,10})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const kobo = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return isKobo(kobo) ? kobo : null;
}

/** "1500.50" for a form field, from kobo. */
export function koboToInput(kobo: number): string {
  const rest = kobo % 100;
  return rest === 0 ? String(Math.floor(kobo / 100)) : `${Math.floor(kobo / 100)}.${String(rest).padStart(2, "0")}`;
}
