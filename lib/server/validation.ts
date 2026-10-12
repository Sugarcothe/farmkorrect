import "server-only";
import {
  FARM_LIMITS,
  FIELD_MAX_LENGTH,
  normalizePhone,
  validateEmail,
  validateFarmName,
  validateFullName,
  validateIdentifier,
  validateLocation,
  validateNewPassword,
  validatePhone,
} from "@/lib/auth/validation";
import { FARM_TYPES, ROLES, type FarmType, type Role } from "@/lib/auth/types";
import { HttpError, str } from "./http";
import { MAX_PASSWORD_LENGTH } from "./passwords";

// Server-side re-validation of every request body. The browser runs the same
// rules from lib/auth/validation.ts, but nothing it sends is trusted.

type FieldErrors = Record<string, string>;

function throwIfErrors(errors: Record<string, string | undefined>) {
  const fieldErrors: FieldErrors = {};
  for (const [key, message] of Object.entries(errors)) if (message) fieldErrors[key] = message;
  if (Object.keys(fieldErrors).length > 0)
    throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
}

function validatePasswordLength(password: string) {
  return password.length > MAX_PASSWORD_LENGTH
    ? `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`
    : undefined;
}

export type RegistrationInput = {
  role: Role;
  fullName: string;
  email: string;
  phone: string;
  password: string;
};

export function parseRegistration(body: Record<string, unknown>): RegistrationInput {
  const role = str(body, "role");
  const fullName = str(body, "fullName").trim().replace(/\s+/g, " ");
  const email = str(body, "email").trim().toLowerCase();
  const phone = str(body, "phone");
  const password = str(body, "password");

  throwIfErrors({
    role: (ROLES as readonly string[]).includes(role) ? undefined : "Choose how you'll use Farm Korect Nig.",
    fullName:
      validateFullName(fullName) ??
      (fullName.length > FIELD_MAX_LENGTH.fullName ? "Enter a shorter name." : undefined),
    email:
      validateEmail(email) ??
      (email.length > FIELD_MAX_LENGTH.email ? "Enter a shorter email address." : undefined),
    phone: validatePhone(phone),
    password: validateNewPassword(password) ?? validatePasswordLength(password),
  });

  return { role: role as Role, fullName, email, phone: normalizePhone(phone)!, password };
}

export type LoginInput =
  | { kind: "email"; value: string; password: string }
  | { kind: "phone"; value: string; password: string };

export function parseLogin(body: Record<string, unknown>): LoginInput {
  const raw = str(body, "identifier").trim();
  const password = str(body, "password");
  throwIfErrors({
    identifier: identifierError(raw),
    password: !password ? "Enter your password." : validatePasswordLength(password),
  });
  return { ...toIdentifier(raw), password };
}

function identifierError(raw: string) {
  return (
    validateIdentifier(raw) ??
    (raw.length > FIELD_MAX_LENGTH.email ? "Enter a shorter email address." : undefined)
  );
}

export function parseIdentifier(body: Record<string, unknown>) {
  const raw = str(body, "identifier").trim();
  throwIfErrors({ identifier: identifierError(raw) });
  return toIdentifier(raw);
}

function toIdentifier(raw: string): { kind: "email"; value: string } | { kind: "phone"; value: string } {
  return raw.includes("@")
    ? { kind: "email", value: raw.toLowerCase() }
    : { kind: "phone", value: normalizePhone(raw)! };
}

/** The phone a verification request refers to, in E.164. */
export function parsePhone(body: Record<string, unknown>): string {
  const phone = normalizePhone(str(body, "phone"));
  if (!phone) throw new HttpError(400, "Enter a valid Nigerian mobile number.");
  return phone;
}

export function parseOtpCode(body: Record<string, unknown>): string {
  const code = str(body, "code");
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "Enter all 6 digits of the code.");
  return code;
}

export function parsePasswordReset(body: Record<string, unknown>) {
  const token = str(body, "token");
  const password = str(body, "password");
  throwIfErrors({ password: validateNewPassword(password) ?? validatePasswordLength(password) });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpError(400, "This reset link is invalid or has expired. Please request a new one.");
  return { token, password };
}

export type FarmInput = {
  farmName: string;
  location: string;
  farmType: FarmType;
  birdCount: number;
  yearsOfExperience: number;
};

function wholeNumberError(
  value: unknown,
  { label, min, max }: { readonly label: string; readonly min: number; readonly max: number },
) {
  if (typeof value !== "number" || !Number.isInteger(value))
    return `Enter the ${label} as a whole number.`;
  if (value < min || value > max)
    return `Enter a ${label} between ${min.toLocaleString()} and ${max.toLocaleString()}.`;
}

/** Only the five farm fields are read; anything else in the body is ignored. */
export function parseFarm(body: Record<string, unknown>): FarmInput {
  const farmName = str(body, "farmName").trim().replace(/\s+/g, " ");
  const location = str(body, "location").trim().replace(/\s+/g, " ");
  const farmType = str(body, "farmType");

  throwIfErrors({
    farmName: validateFarmName(farmName),
    location: validateLocation(location),
    farmType: (FARM_TYPES as readonly string[]).includes(farmType) ? undefined : "Choose your farm type.",
    birdCount: wholeNumberError(body.birdCount, FARM_LIMITS.birdCount),
    yearsOfExperience: wholeNumberError(body.yearsOfExperience, FARM_LIMITS.yearsOfExperience),
  });

  return {
    farmName,
    location,
    farmType: farmType as FarmType,
    birdCount: body.birdCount as number,
    yearsOfExperience: body.yearsOfExperience as number,
  };
}
