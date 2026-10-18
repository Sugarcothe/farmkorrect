import { isNigerianState, type NigerianState } from "@/lib/locations/nigeria";
import { cleanText } from "@/lib/profile/validation";
import { cleanVetSearch } from "@/lib/vets/query";
import { isDateString } from "@/lib/vets/schedule";
import {
  isMarketplaceCategory,
  isServicePricing,
  MARKETPLACE_CATEGORIES,
  SERVICE_LIMITS,
  type MarketplaceCategory,
  type ServicePricing,
} from "./config";

// The Other Services marketplace (docs/other-services.md): the directory
// query, what a booking asks for in each category, the booking statuses and
// the shapes the API sends. Shared by the browser and the server; the server
// always decides.

// --- the directory ---------------------------------------------------------------

export const SERVICE_DIRECTORY_PAGE_SIZE = 12;
export const SERVICE_DIRECTORY_MAX_PAGE_SIZE = 24;

export type ServiceDirectoryQuery = {
  q: string;
  category: MarketplaceCategory | null;
  state: NigerianState | null;
  pricing: ServicePricing | null;
  /** whole naira; fixed-price services only */
  maxPrice: number | null;
};

export const DEFAULT_SERVICE_QUERY: ServiceDirectoryQuery = {
  q: "",
  category: null,
  state: null,
  pricing: null,
  maxPrice: null,
};

const isMaxPrice = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,7}$/.test(value) && Number(value) <= SERVICE_LIMITS.maxPriceNgn;

/**
 * Reads the filters from URL parameters. Anything unrecognised is dropped
 * and named in `invalid` (the API refuses those; the page ignores them).
 * A price limit only makes sense for fixed prices, so it implies them.
 */
export function parseServiceQuery(params: URLSearchParams): { query: ServiceDirectoryQuery; invalid: string[] } {
  const invalid: string[] = [];
  const pick = <T>(key: string, valid: (v: unknown) => v is T): T | null => {
    const raw = params.get(key);
    if (raw === null || raw === "") return null;
    if (valid(raw)) return raw;
    invalid.push(key);
    return null;
  };
  const maxPrice = pick("maxPrice", isMaxPrice);
  let pricing = pick("pricing", isServicePricing);
  if (maxPrice !== null) {
    if (pricing === "quote") invalid.push("maxPrice");
    else pricing = "fixed";
  }
  return {
    query: {
      q: cleanVetSearch(params.get("q") ?? ""),
      category: pick("category", isMarketplaceCategory),
      state: pick("state", isNigerianState),
      pricing,
      maxPrice: maxPrice !== null && pricing === "fixed" ? Number(maxPrice) : null,
    },
    invalid,
  };
}

/** URL parameters for a query, defaults left out, always in the same order. */
export function serviceQueryParams(query: ServiceDirectoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.state) params.set("state", query.state);
  if (query.pricing) params.set("pricing", query.pricing);
  if (query.maxPrice !== null) params.set("maxPrice", String(query.maxPrice));
  return params;
}

/** The canonical text a directory cursor is bound to. */
export const canonicalServiceQuery = (query: ServiceDirectoryQuery) => serviceQueryParams(query).toString();

export const hasServiceFilters = (query: ServiceDirectoryQuery) =>
  Boolean(query.q || query.category || query.state || query.pricing || query.maxPrice !== null);

export type ServiceProviderSummary = {
  id: string;
  name: string;
  photoUrl: string | null;
  roleLabel: string;
  /** an admin approved the credentials they submitted; false when none were reviewed */
  credentialsVerified: boolean;
};

export type ServiceCard = {
  id: string;
  name: string;
  category: MarketplaceCategory;
  categoryLabel: string;
  description: string;
  pricing: ServicePricing;
  /** whole naira; null for quote on request */
  priceNgn: number | null;
  durationMinutes: number | null;
  serviceStates: NigerianState[];
  provider: ServiceProviderSummary;
};

export type ServiceDirectoryPage = { services: ServiceCard[]; nextCursor: string | null };

export type MarketplaceServiceDetails = ServiceCard & {
  included: string;
  excluded: string;
  requirements: string;
  /** false when it's the viewer's own service */
  canBook: boolean;
};

export type ServiceProviderProfile = ServiceProviderSummary & {
  bio: string;
  location: string;
  yearsOfExperience: number | null;
  services: ServiceCard[];
};

// --- what a booking asks for ---------------------------------------------------

type Option = { value: string; label: string };

export type DetailField =
  | { key: string; label: string; kind: "text"; required: boolean; min: number; max: number; hint?: string }
  | { key: string; label: string; kind: "textarea"; required: boolean; min: number; max: number; hint?: string }
  | { key: string; label: string; kind: "number"; required: boolean; min: number; max: number; unit?: string }
  | { key: string; label: string; kind: "select"; required: boolean; options: readonly Option[] }
  | { key: string; label: string; kind: "state"; required: boolean };

const EQUIPMENT: readonly Option[] = [
  { value: "drinkers-feeders", label: "Drinkers & feeders" },
  { value: "cages", label: "Battery cages" },
  { value: "lighting", label: "Lighting" },
  { value: "ventilation", label: "Ventilation & fans" },
  { value: "brooders", label: "Brooders & heaters" },
  { value: "generator", label: "Generator" },
  { value: "borehole", label: "Borehole & pumps" },
  { value: "solar", label: "Solar power" },
  { value: "other", label: "Other" },
];

const DROPOFF: DetailField[] = [
  { key: "dropoffAddress", label: "Drop-off address", kind: "text", required: true, min: 5, max: 160 },
  { key: "dropoffState", label: "Drop-off state", kind: "state", required: true },
];

/**
 * What each category asks the customer for, on top of the date, location,
 * contact preference and notes every booking has. The location is where the
 * work happens (for moving goods: the pickup point).
 */
export const CATEGORY_FIELDS: Record<MarketplaceCategory, readonly DetailField[]> = {
  "farm-fumigation": [
    {
      key: "premisesType",
      label: "What needs fumigating",
      kind: "select",
      required: true,
      options: [
        { value: "poultry-house", label: "Poultry house" },
        { value: "feed-store", label: "Feed store" },
        { value: "hatchery", label: "Hatchery" },
        { value: "whole-farm", label: "Whole farm" },
        { value: "other", label: "Other" },
      ],
    },
    { key: "areaSqm", label: "Approximate area", kind: "number", required: true, min: 1, max: 1_000_000, unit: "m²" },
    { key: "pestProblem", label: "Pest or problem", kind: "textarea", required: true, min: 3, max: 300 },
  ],
  recruitment: [
    {
      key: "position",
      label: "Position to fill",
      kind: "text",
      required: true,
      min: 3,
      max: 80,
      hint: "e.g. Farm attendant",
    },
    { key: "headcount", label: "Number of people", kind: "number", required: true, min: 1, max: 100 },
    {
      key: "employmentType",
      label: "Type of work",
      kind: "select",
      required: true,
      options: [
        { value: "full-time", label: "Full-time" },
        { value: "part-time", label: "Part-time" },
        { value: "contract", label: "Contract" },
        { value: "one-off", label: "One-off job" },
      ],
    },
  ],
  transportation: [
    {
      key: "cargo",
      label: "What is being moved",
      kind: "select",
      required: true,
      options: [
        { value: "live-birds", label: "Live birds" },
        { value: "eggs", label: "Eggs" },
        { value: "feed", label: "Feed" },
        { value: "equipment", label: "Equipment" },
        { value: "other", label: "Other" },
      ],
    },
    {
      key: "quantity",
      label: "Quantity",
      kind: "text",
      required: true,
      min: 1,
      max: 80,
      hint: "e.g. 300 birds, 50 crates",
    },
    ...DROPOFF,
  ],
  logistics: [
    { key: "goods", label: "Goods", kind: "text", required: true, min: 3, max: 80 },
    { key: "weightKg", label: "Approximate weight", kind: "number", required: false, min: 1, max: 100_000, unit: "kg" },
    ...DROPOFF,
  ],
  "sales-connection": [
    {
      key: "product",
      label: "What you're selling",
      kind: "select",
      required: true,
      options: [
        { value: "live-birds", label: "Live birds" },
        { value: "eggs", label: "Eggs" },
        { value: "processed-birds", label: "Processed birds" },
        { value: "manure", label: "Manure" },
        { value: "other", label: "Other" },
      ],
    },
    { key: "quantity", label: "Quantity", kind: "text", required: true, min: 1, max: 80 },
    {
      key: "targetPriceNgn",
      label: "Price you hope for (₦, optional)",
      kind: "number",
      required: false,
      min: 1,
      max: 10_000_000,
    },
  ],
  installation: [
    { key: "equipmentType", label: "Equipment", kind: "select", required: true, options: EQUIPMENT },
    { key: "units", label: "Number of units", kind: "number", required: true, min: 1, max: 10_000 },
  ],
  maintenance: [
    { key: "equipmentType", label: "Equipment", kind: "select", required: true, options: EQUIPMENT },
    { key: "issue", label: "What's wrong", kind: "textarea", required: true, min: 3, max: 300 },
  ],
};

export type BookingDetails = Record<string, string | number>;

/**
 * Checks a category's own booking fields. Only the keys the category defines
 * are read; anything else is ignored. Numbers may arrive as numbers or digit
 * strings and are stored as integers.
 */
export function validateBookingDetails(
  category: MarketplaceCategory,
  raw: unknown,
): { details: BookingDetails; errors: Record<string, string> } {
  const input = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const details: BookingDetails = {};
  const errors: Record<string, string> = {};
  for (const field of CATEGORY_FIELDS[category]) {
    const value = input[field.key];
    const empty = value === undefined || value === null || value === "";
    if (empty) {
      if (field.required)
        errors[field.key] = field.kind === "select" || field.kind === "state" ? "Choose one." : "Required.";
      continue;
    }
    switch (field.kind) {
      case "text":
      case "textarea": {
        const text = typeof value === "string" ? cleanText(value, field.kind === "textarea") : "";
        if (typeof value !== "string" || text.length < field.min || text.length > field.max)
          errors[field.key] = `Enter ${field.min}–${field.max} characters.`;
        else if (text) details[field.key] = text;
        break;
      }
      case "number": {
        const n =
          typeof value === "number"
            ? value
            : typeof value === "string" && /^\d{1,9}$/.test(value)
              ? Number(value)
              : NaN;
        if (!Number.isSafeInteger(n) || n < field.min || n > field.max)
          errors[field.key] =
            `Enter a whole number from ${field.min.toLocaleString("en-NG")} to ${field.max.toLocaleString("en-NG")}.`;
        else details[field.key] = n;
        break;
      }
      case "select":
        if (!field.options.some((o) => o.value === value)) errors[field.key] = "Choose one.";
        else details[field.key] = value as string;
        break;
      case "state":
        if (!isNigerianState(value)) errors[field.key] = "Choose a state.";
        else details[field.key] = value;
        break;
    }
  }
  return { details, errors };
}

/** The category fields as label/value pairs, for display. */
export function describeDetails(category: string, details: BookingDetails, stateName: (s: NigerianState) => string) {
  if (!isMarketplaceCategory(category)) return [];
  return CATEGORY_FIELDS[category].flatMap((field) => {
    const value = details[field.key];
    if (value === undefined) return [];
    const shown =
      field.kind === "select"
        ? (field.options.find((o) => o.value === value)?.label ?? String(value))
        : field.kind === "state"
          ? stateName(value as NigerianState)
          : field.kind === "number"
            ? `${value.toLocaleString("en-NG")}${field.unit ? ` ${field.unit}` : ""}`
            : String(value);
    return [{ label: field.label, value: shown }];
  });
}

export const TIME_WINDOWS = [
  { value: "morning", label: "Morning (8am – 12pm)" },
  { value: "afternoon", label: "Afternoon (12pm – 4pm)" },
  { value: "evening", label: "Evening (4pm – 7pm)" },
  { value: "flexible", label: "Any time that day" },
] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number]["value"];
export const isTimeWindow = (value: unknown): value is TimeWindow => TIME_WINDOWS.some((w) => w.value === value);
export const timeWindowLabel = (value: string) => TIME_WINDOWS.find((w) => w.value === value)?.label ?? value;

export const CONTACT_PREFERENCES = [
  { value: "call", label: "Phone call" },
  { value: "sms", label: "Text message" },
] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number]["value"];
export const isContactPreference = (value: unknown): value is ContactPreference =>
  CONTACT_PREFERENCES.some((c) => c.value === value);

export const SERVICE_BOOKING_RULES = {
  /** the earliest date that can be booked, in days from today (Lagos) */
  minDaysAhead: 1,
  maxDaysAhead: 90,
  /** a fixed-price booking must be paid within this, or it lapses */
  payWithinMs: 30 * 60_000,
  /** the provider must answer a request within this (or by the booked date if sooner) */
  respondWithinMs: 24 * 60 * 60_000,
  /** how long a quote can be accepted for */
  quoteValidDays: { min: 1, max: 7, default: 3 },
  /** open bookings (anything not finished) one customer can have at once */
  maxOpenPerCustomer: 5,
  address: { min: 5, max: 160 },
  directions: 300,
  notes: 500,
  reason: 200,
  quoteNote: 300,
} as const;

export { isDateString };

export const marketplaceCategoryInfo = (value: string) => MARKETPLACE_CATEGORIES.find((c) => c.value === value) ?? null;

// --- bookings --------------------------------------------------------------------

export const SERVICE_BOOKING_STATUSES = [
  "requested",
  "quote_offered",
  "awaiting_payment",
  "confirmed",
  "provider_en_route",
  "in_progress",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;
export type ServiceBookingStatus = (typeof SERVICE_BOOKING_STATUSES)[number];

/** Not finished: counts towards the customer's limit and can still change. */
export const OPEN_SERVICE_BOOKING_STATUSES: readonly ServiceBookingStatus[] = [
  "requested",
  "quote_offered",
  "awaiting_payment",
  "confirmed",
  "provider_en_route",
  "in_progress",
];

export const SERVICE_BOOKING_STATUS_LABELS: Record<ServiceBookingStatus, string> = {
  requested: "Waiting for the provider",
  quote_offered: "Quote received",
  awaiting_payment: "Awaiting payment",
  confirmed: "Confirmed",
  provider_en_route: "Provider on the way",
  in_progress: "In progress",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
};

export type ServicePaymentStatus =
  "none" | "pending" | "failed" | "paid" | "refund_pending" | "refunded" | "refund_failed";

export const SERVICE_PAYMENT_STATUS_LABELS: Record<ServicePaymentStatus, string> = {
  none: "Nothing paid",
  pending: "Not paid yet",
  failed: "Payment failed",
  paid: "Paid",
  refund_pending: "Refund in progress",
  refunded: "Refunded",
  refund_failed: "Refund needs attention",
};

/** Everything a booking's history records: status changes and payment events. */
export type ServiceBookingEvent =
  ServiceBookingStatus | "paid" | "payment_failed" | "refund_processed" | "refund_failed" | "late_payment_refunded";

export type ServiceBookingActor = "customer" | "provider" | "system";

export const SERVICE_BOOKING_ACTIONS = [
  "accept",
  "decline",
  "quote",
  "accept_quote",
  "reject_quote",
  "en_route",
  "start",
  "complete",
  "cancel",
] as const;
export type ServiceBookingAction = (typeof SERVICE_BOOKING_ACTIONS)[number];

export const SERVICE_BOOKING_ACTION_LABELS: Record<ServiceBookingAction, string> = {
  accept: "Accept booking",
  decline: "Decline",
  quote: "Send quote",
  accept_quote: "Accept quote",
  reject_quote: "Reject quote",
  en_route: "I'm on the way",
  start: "Start job",
  complete: "Mark completed",
  cancel: "Cancel booking",
};

export type ServiceBookingViewer = "customer" | "provider";

export type ServiceBooking = {
  id: string;
  reference: string;
  viewer: ServiceBookingViewer;
  service: { id: string; name: string; category: string; categoryLabel: string; pricing: ServicePricing };
  provider: { id: string; name: string; photoUrl: string | null; phone: string | null };
  customer: { name: string; phone: string | null };
  schedule: { date: string; window: TimeWindow };
  location: { address: string; state: NigerianState; directions: string };
  contactPreference: ContactPreference;
  notes: string;
  details: { label: string; value: string }[];
  status: ServiceBookingStatus;
  paymentStatus: ServicePaymentStatus;
  /** what the customer pays, in kobo; null until a quote is accepted */
  amountKobo: number | null;
  paidKobo: number;
  refundedKobo: number;
  quote: { amountKobo: number; note: string; offeredAt: string; validUntil: string } | null;
  respondBy: string | null;
  payBy: string | null;
  history: { event: ServiceBookingEvent; by: ServiceBookingActor; at: string; note: string | null }[];
  actions: ServiceBookingAction[];
  /** the customer can start or resume paying now */
  canPay: boolean;
  /** the last date the customer can cancel a confirmed booking for a refund */
  cancelUntil: string | null;
  createdAt: string;
};

export type ServiceBookingSummary = {
  id: string;
  reference: string;
  viewer: ServiceBookingViewer;
  serviceName: string;
  categoryLabel: string;
  date: string;
  window: TimeWindow;
  status: ServiceBookingStatus;
  paymentStatus: ServicePaymentStatus;
  amountKobo: number | null;
  otherParty: string;
};

export type ServiceBookingResponse = { booking: ServiceBooking };
export type ServiceBookingListResponse = { bookings: ServiceBookingSummary[]; nextCursor: string | null };
export type ServiceCheckoutResponse = { authorizationUrl: string; reference: string };
export type ServicePaymentCheck = "paid" | "pending" | "failed" | "unknown";
export type ServiceVerifyResponse = { result: ServicePaymentCheck; booking: ServiceBooking };

/** POST /api/service-bookings */
export type ServiceBookingRequest = {
  serviceId: string;
  date: string;
  window: TimeWindow;
  location: { address: string; state: NigerianState; directions?: string };
  contactPreference: ContactPreference;
  notes?: string;
  details: Record<string, string | number>;
  idempotencyKey: string;
};

/** PATCH /api/service-bookings/[id] */
export type ServiceBookingTransitionRequest = {
  action: ServiceBookingAction;
  expectedStatus: ServiceBookingStatus;
  reason?: string;
  /** "quote" only: whole naira, and how many days it's valid for */
  quote?: { amountNgn: number; note?: string; validDays?: number };
};
