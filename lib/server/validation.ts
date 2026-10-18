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
import { PROFILE_CONFIG } from "@/lib/profile/config";
import type { ProfileField } from "@/lib/profile/types";
import {
  cleanText,
  validateBio,
  validatePracticeLocation,
  validateQualifications,
  validateRegistrationNumber,
  validateSpecialization,
} from "@/lib/profile/validation";
import { serviceCategory } from "@/lib/services/config";
import type { MarketplaceFields, ServiceFields } from "@/lib/services/types";
import {
  validateDurationMinutes,
  validatePriceNgn,
  validatePricing,
  validateServiceCategory,
  validateServiceDescription,
  validateServiceName,
  validateServiceNote,
  validateServiceStates,
} from "@/lib/services/validation";
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
    role: (ROLES as readonly string[]).includes(role) ? undefined : "Choose how you'll use Farm Korret Nig.",
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

export type ProfileUpdate = {
  fullName?: string;
  bio?: string;
  location?: string;
  yearsOfExperience?: number;
  farmName?: string;
  farmType?: FarmType;
  birdCount?: number;
  specialization?: string;
  qualifications?: string;
  registrationNumber?: string;
};

const NUMBER_FIELDS = new Set<ProfileField>(["yearsOfExperience", "birdCount"]);

/**
 * A profile edit: any subset of the fields the account's role may change.
 * The role comes from the stored account, never the body. Every other key —
 * role, email, phone, status, verification flags, credential status, ids —
 * is refused rather than silently ignored, so nothing protected can be set
 * through this endpoint.
 */
export function parseProfileUpdate(role: Role, body: Record<string, unknown>): ProfileUpdate {
  const allowed = new Set<string>(PROFILE_CONFIG[role].editableFields);
  const refused = Object.keys(body).filter((key) => !allowed.has(key));
  if (refused.length > 0) {
    // fromEntries defines own properties, so even a "__proto__" key is reported
    const fieldErrors = Object.fromEntries(
      refused.map((key) => [key, "This can't be changed from your profile."]),
    ) as Record<string, string>;
    throw new HttpError(400, "Some of these details can't be changed from your profile.", fieldErrors);
  }

  const keys = Object.keys(body) as ProfileField[];
  if (keys.length === 0) throw new HttpError(400, "There are no changes to save.");

  const typeErrors: Record<string, string | undefined> = {};
  for (const key of keys) {
    const expected = NUMBER_FIELDS.has(key) ? "number" : "string";
    if (typeof body[key] !== expected)
      typeErrors[key] = expected === "number" ? "Enter a whole number." : "Enter text.";
  }
  throwIfErrors(typeErrors);

  const text = (key: ProfileField, multiline = false) => cleanText(body[key] as string, multiline);
  const has = (key: ProfileField) => keys.includes(key);
  const isFarmer = role === "poultry-farmer";
  const update: ProfileUpdate = {};
  const errors: Record<string, string | undefined> = {};

  if (has("fullName")) {
    update.fullName = text("fullName");
    errors.fullName =
      validateFullName(update.fullName) ??
      (update.fullName.length > FIELD_MAX_LENGTH.fullName ? "Enter a shorter name." : undefined);
  }
  if (has("bio")) {
    update.bio = text("bio", true);
    errors.bio = validateBio(update.bio);
  }
  if (has("location")) {
    update.location = text("location");
    errors.location = isFarmer ? validateLocation(update.location) : validatePracticeLocation(update.location);
  }
  if (has("yearsOfExperience")) {
    update.yearsOfExperience = body.yearsOfExperience as number;
    errors.yearsOfExperience = wholeNumberError(body.yearsOfExperience, FARM_LIMITS.yearsOfExperience);
  }
  if (has("farmName")) {
    update.farmName = text("farmName");
    errors.farmName = validateFarmName(update.farmName);
  }
  if (has("farmType")) {
    const farmType = body.farmType as string;
    errors.farmType = (FARM_TYPES as readonly string[]).includes(farmType) ? undefined : "Choose your farm type.";
    update.farmType = farmType as FarmType;
  }
  if (has("birdCount")) {
    update.birdCount = body.birdCount as number;
    errors.birdCount = wholeNumberError(body.birdCount, FARM_LIMITS.birdCount);
  }
  if (has("specialization")) {
    update.specialization = body.specialization as string;
    errors.specialization = validateSpecialization(role, update.specialization);
  }
  if (has("qualifications")) {
    update.qualifications = text("qualifications");
    errors.qualifications = validateQualifications(update.qualifications);
  }
  if (has("registrationNumber")) {
    update.registrationNumber = text("registrationNumber").toUpperCase();
    errors.registrationNumber = validateRegistrationNumber(update.registrationNumber);
  }

  throwIfErrors(errors);
  return update;
}

const SERVICE_FIELD_TYPES = {
  name: "text",
  category: "text",
  description: "text",
  priceNgn: "number",
  durationMinutes: "duration",
  active: "boolean",
  bookingAvailable: "boolean",
  pricing: "text",
  serviceStates: "list",
  included: "text",
  excluded: "text",
  requirements: "text",
} as const satisfies Record<keyof ServiceFields, string>;

const SERVICE_TYPE_ERRORS = {
  text: "Enter text.",
  list: "Choose from the list.",
  number: "Enter the price as a number.",
  duration: "Choose one of the listed durations.",
  boolean: "Choose on or off.",
} as const;

function isServiceField(key: string): key is keyof ServiceFields {
  return Object.hasOwn(SERVICE_FIELD_TYPES, key);
}

/**
 * The service fields present in a body, type-checked and with text cleaned.
 * Any other key — ownerUserId, _id, archivedAt, timestamps, bookable — is
 * refused rather than silently ignored, so ownership and bookkeeping can
 * never be set through the API.
 */
function readServiceFields(body: Record<string, unknown>): Partial<ServiceFields> {
  const refused = Object.keys(body).filter((key) => !isServiceField(key));
  if (refused.length > 0) {
    const fieldErrors = Object.fromEntries(
      refused.map((key) => [key, "This can't be set on a service."]),
    ) as Record<string, string>;
    throw new HttpError(400, "Some of these details can't be set on a service.", fieldErrors);
  }

  const typeErrors: Record<string, string | undefined> = {};
  for (const key of Object.keys(body) as Array<keyof ServiceFields>) {
    const kind = SERVICE_FIELD_TYPES[key];
    const value = body[key];
    const valid =
      kind === "text"
        ? typeof value === "string"
        : kind === "number"
          ? typeof value === "number"
          : kind === "duration"
            ? value === null || typeof value === "number"
            : kind === "list"
              ? Array.isArray(value) && value.length <= 50 && value.every((v) => typeof v === "string")
              : typeof value === "boolean";
    if (!valid) typeErrors[key] = SERVICE_TYPE_ERRORS[kind];
  }
  throwIfErrors(typeErrors);

  const fields = { ...body } as Partial<ServiceFields>;
  if (fields.name !== undefined) fields.name = cleanText(fields.name);
  if (fields.description !== undefined) fields.description = cleanText(fields.description, true);
  for (const key of ["included", "excluded", "requirements"] as const)
    if (fields[key] !== undefined) fields[key] = cleanText(fields[key], true);
  return fields;
}

const MARKETPLACE_KEYS = ["pricing", "serviceStates", "included", "excluded", "requirements"] as const;

/**
 * The marketplace details of a service whose (new or current) category is
 * `category`. Other Services categories need pricing and at least one state;
 * every other category refuses them. `current` holds the stored values an
 * update may leave unchanged.
 */
function marketplaceErrors(
  role: Role,
  category: string,
  fields: Partial<ServiceFields>,
  current: Partial<MarketplaceFields>,
): Record<string, string | undefined> {
  if (!serviceCategory(role, category)?.marketplace)
    return Object.fromEntries(
      MARKETPLACE_KEYS.filter((key) => fields[key] !== undefined).map((key) => [
        key,
        "This only applies to Other Services categories.",
      ]),
    );
  return {
    pricing: validatePricing(fields.pricing ?? current.pricing),
    serviceStates: validateServiceStates(fields.serviceStates ?? current.serviceStates),
    included: fields.included === undefined ? undefined : validateServiceNote(fields.included),
    excluded: fields.excluded === undefined ? undefined : validateServiceNote(fields.excluded),
    requirements: fields.requirements === undefined ? undefined : validateServiceNote(fields.requirements),
  };
}

const QUOTE_HAS_NO_PRICE = "A quote-on-request service has no fixed price. Leave the price empty.";

/** A new service. Text, category, price and duration are required. */
export function parseNewService(role: Role, body: Record<string, unknown>): ServiceFields {
  const fields = readServiceFields(body);
  const category = fields.category ?? "";
  const market = serviceCategory(role, category)?.marketplace === true;
  const quote = market && fields.pricing === "quote";
  throwIfErrors({
    name: validateServiceName(fields.name ?? ""),
    category: validateServiceCategory(role, category),
    description: validateServiceDescription(fields.description ?? ""),
    priceNgn: quote
      ? fields.priceNgn === undefined || fields.priceNgn === 0
        ? undefined
        : QUOTE_HAS_NO_PRICE
      : fields.priceNgn === undefined
        ? "Enter a price in naira."
        : validatePriceNgn(role, fields.priceNgn, category),
    durationMinutes:
      fields.durationMinutes === undefined ? "Choose a duration." : validateDurationMinutes(fields.durationMinutes),
    ...marketplaceErrors(role, category, fields, {}),
  });
  return {
    name: fields.name!,
    category,
    description: fields.description!,
    priceNgn: quote ? 0 : fields.priceNgn!,
    durationMinutes: fields.durationMinutes!,
    active: fields.active ?? true,
    bookingAvailable: fields.bookingAvailable ?? true,
    ...(market
      ? {
          pricing: fields.pricing!,
          serviceStates: fields.serviceStates!,
          included: fields.included ?? "",
          excluded: fields.excluded ?? "",
          requirements: fields.requirements ?? "",
        }
      : {}),
  };
}

/**
 * Changes to an existing service: any subset of its editable fields. Only
 * what changes is validated, except that a new price or category is checked
 * against the other (some categories can't be free).
 */
export function parseServiceUpdate(
  role: Role,
  body: Record<string, unknown>,
  current: Pick<ServiceFields, "category" | "priceNgn"> & Partial<MarketplaceFields>,
): Partial<ServiceFields> {
  const fields = readServiceFields(body);
  if (Object.keys(fields).length === 0) throw new HttpError(400, "There are no changes to save.");

  const category = fields.category ?? current.category;
  const market = serviceCategory(role, category)?.marketplace === true;
  // stored marketplace details only carry over while the service stays in the marketplace
  const stored: Partial<MarketplaceFields> = serviceCategory(role, current.category)?.marketplace ? current : {};
  const quote = market && (fields.pricing ?? stored.pricing) === "quote";
  const priceChecked = fields.priceNgn !== undefined || fields.category !== undefined || fields.pricing !== undefined;
  throwIfErrors({
    name: fields.name === undefined ? undefined : validateServiceName(fields.name),
    category: fields.category === undefined ? undefined : validateServiceCategory(role, fields.category),
    description: fields.description === undefined ? undefined : validateServiceDescription(fields.description),
    priceNgn: quote
      ? fields.priceNgn === undefined || fields.priceNgn === 0
        ? undefined
        : QUOTE_HAS_NO_PRICE
      : priceChecked
        ? validatePriceNgn(role, fields.priceNgn ?? current.priceNgn, category)
        : undefined,
    durationMinutes:
      fields.durationMinutes === undefined ? undefined : validateDurationMinutes(fields.durationMinutes),
    ...(market || MARKETPLACE_KEYS.some((key) => fields[key] !== undefined)
      ? marketplaceErrors(role, category, fields, stored)
      : {}),
  });
  if (quote) fields.priceNgn = 0;
  return fields;
}
