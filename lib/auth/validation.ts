// Pure validators: each returns an error message, or undefined when valid.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Nigerian mobile numbers: 0803…, 803…, 234803… or +234803… (70x, 80x, 81x, 90x, 91x)
const NG_PHONE_PATTERN = /^(?:\+?234|0)?([789][01]\d{8})$/;

export const PASSWORD_HINT =
  "At least 8 characters, including a letter and a number.";

export function normalizePhone(input: string): string | null {
  const match = input.replace(/[\s\-().]/g, "").match(NG_PHONE_PATTERN);
  return match ? `+234${match[1]}` : null;
}

export function maskPhone(phone: string): string {
  return `+234******${phone.slice(-4)}`;
}

export function validateFullName(value: string) {
  const name = value.trim();
  if (!name) return "Enter your full name.";
  if (name.length < 2 || !/\p{L}/u.test(name))
    return "Enter your name as it appears on your ID.";
}

export function validateEmail(value: string) {
  if (!value.trim()) return "Enter your email address.";
  if (!EMAIL_PATTERN.test(value.trim())) return "Enter a valid email address.";
}

export function validatePhone(value: string) {
  if (!value.trim()) return "Enter your phone number.";
  if (!normalizePhone(value))
    return "Enter a valid Nigerian mobile number, e.g. 0812 345 6789.";
}

export function validateNewPassword(value: string) {
  if (!value) return "Create a password.";
  if (value.length < 8 || !/[A-Za-z]/.test(value) || !/\d/.test(value))
    return PASSWORD_HINT;
}

export function validateIdentifier(value: string) {
  const id = value.trim();
  if (!id) return "Enter your email address or phone number.";
  const valid = id.includes("@") ? EMAIL_PATTERN.test(id) : normalizePhone(id);
  if (!valid) return "Enter a valid email address or Nigerian phone number.";
}

/** Email addresses are lower-cased; phone numbers are normalised to E.164. */
export function normalizeIdentifier(value: string): string {
  const id = value.trim();
  return id.includes("@") ? id.toLowerCase() : (normalizePhone(id) ?? id);
}

export const FIELD_MAX_LENGTH = {
  fullName: 100,
  email: 254,
  farmName: 100,
  location: 120,
} as const;

export const FARM_LIMITS = {
  birdCount: { label: "number of birds", min: 1, max: 10_000_000 },
  yearsOfExperience: { label: "years of experience", min: 0, max: 80 },
} as const;

export function validateFarmName(value: string) {
  const name = value.trim();
  if (!name) return "Enter your farm's name.";
  if (name.length > FIELD_MAX_LENGTH.farmName) return "Enter a shorter farm name.";
}

export function validateLocation(value: string) {
  const location = value.trim();
  if (!location) return "Enter your farm's town and state.";
  if (location.length > FIELD_MAX_LENGTH.location) return "Enter a shorter location.";
}

export function parseWholeNumber(value: string): number | null {
  const cleaned = value.replace(/[\s,]/g, "");
  return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
}

export function validateWholeNumber(
  value: string,
  { label, min, max }: { label: string; min: number; max: number },
) {
  if (!value.trim()) return `Enter the ${label}.`;
  const n = parseWholeNumber(value);
  if (n === null) return `Enter the ${label} as a whole number.`;
  if (n < min || n > max)
    return `Enter a ${label} between ${min.toLocaleString()} and ${max.toLocaleString()}.`;
}
