import type { Role } from "@/lib/auth/types";
import { SPECIALIZATIONS } from "./config";

// Pure validators for the profile form; each returns an error message, or
// undefined when valid. The server runs them again on every request.

export const PROFILE_MAX_LENGTH = {
  bio: 500,
  location: 120,
  qualifications: 200,
  registrationNumber: 40,
} as const;

const REGISTRATION_NUMBER = /^[A-Za-z0-9][A-Za-z0-9/.\- ]{2,39}$/;

/** Collapses runs of spaces; keeps paragraph breaks in multi-line text. */
export function cleanText(value: string, multiline = false): string {
  // strip control characters (keeping tab and newlines)
  const noControls = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!multiline) return noControls.trim().replace(/\s+/g, " ");
  return noControls
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validateBio(value: string) {
  if (cleanText(value, true).length > PROFILE_MAX_LENGTH.bio)
    return `Keep your bio to ${PROFILE_MAX_LENGTH.bio} characters or fewer.`;
}

export function validatePracticeLocation(value: string) {
  const location = cleanText(value);
  if (!location) return "Enter the town and state where you work.";
  if (location.length > PROFILE_MAX_LENGTH.location) return "Enter a shorter location.";
}

export function validateSpecialization(role: Role, value: string) {
  if (role === "poultry-farmer") return "This field isn't available for your account.";
  if (!value) return "Choose your specialization.";
  if (!SPECIALIZATIONS[role].some((o) => o.value === value)) return "Choose one of the listed options.";
}

export function validateQualifications(value: string) {
  if (cleanText(value).length > PROFILE_MAX_LENGTH.qualifications)
    return `Keep this to ${PROFILE_MAX_LENGTH.qualifications} characters or fewer.`;
}

/** Optional; when present it must look like a registration number (e.g. VCN/1234). */
export function validateRegistrationNumber(value: string) {
  const number = cleanText(value);
  if (!number) return undefined;
  if (!REGISTRATION_NUMBER.test(number))
    return "Use letters, numbers, spaces, / . or - (3 to 40 characters).";
}
