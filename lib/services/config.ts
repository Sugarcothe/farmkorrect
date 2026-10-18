import type { Role } from "@/lib/auth/types";

// What each role may list under Services & Pricing. The screens, the API and
// the validators all read this table; the role itself always comes from the
// signed-in account on the server. A role with no categories can't list
// services and sees an explanation instead of the form.

export type ServiceCategory = {
  value: string;
  label: string;
  /** whether a price of ₦0 ("Free") makes sense for this kind of service */
  allowsFree: boolean;
  /** listed in the Other Services marketplace, where customers book and pay for it */
  marketplace?: true;
};

/**
 * The Other Services marketplace (docs/other-services.md). Customers find
 * these in the Services directory, book them and pay through the app.
 */
export const MARKETPLACE_CATEGORIES = [
  {
    value: "farm-fumigation",
    label: "Farm Fumigation",
    description: "Pest, insect and disease control for poultry houses, stores and hatcheries.",
  },
  {
    value: "recruitment",
    label: "Recruitment",
    description: "Finding farm hands, attendants and managers for your farm.",
  },
  {
    value: "transportation",
    label: "Transportation",
    description: "Moving live birds, eggs, feed or equipment from one place to another.",
  },
  { value: "logistics", label: "Logistics", description: "Pickup, storage and delivery of farm goods and supplies." },
  {
    value: "sales-connection",
    label: "Sales Connection",
    description: "Connecting your birds, eggs and produce with buyers.",
  },
  {
    value: "installation",
    label: "Installation",
    description: "Setting up drinkers, feeders, cages, lighting, ventilation and brooders.",
  },
  {
    value: "maintenance",
    label: "Maintenance",
    description: "Servicing and repairing farm equipment, generators and boreholes.",
  },
] as const;

export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number]["value"];

/**
 * Which marketplace categories each role may offer. Specialists provide
 * technical and support services; farmers with vehicles may move goods for
 * other farmers; vets offer their own services through Find a Vet only.
 */
export const MARKETPLACE_ROLES: Record<Role, readonly MarketplaceCategory[]> = {
  "poultry-farmer": ["transportation", "logistics"],
  veterinarian: [],
  "non-vet-specialist": MARKETPLACE_CATEGORIES.map((c) => c.value),
};

const marketplaceFor = (role: Role): ServiceCategory[] =>
  MARKETPLACE_CATEGORIES.filter((c) => MARKETPLACE_ROLES[role].includes(c.value)).map((c) => ({
    value: c.value,
    label: c.label,
    allowsFree: false,
    marketplace: true,
  }));

export const isMarketplaceCategory = (value: unknown): value is MarketplaceCategory =>
  MARKETPLACE_CATEGORIES.some((c) => c.value === value);

export const marketplaceLabel = (value: string) =>
  MARKETPLACE_CATEGORIES.find((c) => c.value === value)?.label ?? "Other";

export const SERVICE_CATEGORIES: Record<Role, readonly ServiceCategory[]> = {
  // farm services and advice shared with other farmers — not products for
  // sale and not flock records, which belong to other parts of the app
  "poultry-farmer": [
    { value: "farm-advisory", label: "Farm Advisory & Mentoring", allowsFree: true },
    { value: "training-farm-visit", label: "Training & Farm Visits", allowsFree: true },
    { value: "brooding-rearing", label: "Brooding & Rearing", allowsFree: false },
    { value: "bird-processing", label: "Bird Processing & Dressing", allowsFree: false },
    { value: "equipment-hire", label: "Equipment Hire", allowsFree: false },
    ...marketplaceFor("poultry-farmer"),
  ],
  veterinarian: [
    { value: "consultation", label: "Consultation", allowsFree: true },
    { value: "vaccination", label: "Vaccination", allowsFree: false },
    { value: "biosecurity-audit", label: "Biosecurity Audit", allowsFree: false },
    { value: "disease-advisory", label: "Disease Diagnosis & Advisory", allowsFree: true },
    { value: "flock-health-check", label: "Routine Flock Health Check", allowsFree: false },
    { value: "post-mortem", label: "Post-mortem & Lab Referral", allowsFree: false },
    { value: "emergency-visit", label: "Emergency Farm Visit", allowsFree: false },
    ...marketplaceFor("veterinarian"),
  ],
  // one category per specialization a specialist can hold, plus training
  "non-vet-specialist": [
    { value: "nutrition-feed", label: "Nutrition & Feed Formulation", allowsFree: false },
    { value: "farm-management", label: "Farm Management Consulting", allowsFree: true },
    { value: "hatchery-services", label: "Hatchery Services", allowsFree: false },
    { value: "biosecurity-consulting", label: "Biosecurity Consulting", allowsFree: false },
    { value: "housing-equipment", label: "Housing & Equipment Setup", allowsFree: false },
    { value: "processing-marketing", label: "Processing & Marketing Advice", allowsFree: true },
    { value: "training", label: "Training & Workshops", allowsFree: true },
    ...marketplaceFor("non-vet-specialist"),
  ],
};

/** Copy for the top of the Services & Pricing screen. */
export const SERVICES_INTRO: Record<Role, { heading: string; description: string }> = {
  "poultry-farmer": {
    heading: "Services you offer other farmers",
    description:
      "List advice, training or farm services you provide, with a clear price. Birds and products you sell are managed separately.",
  },
  veterinarian: {
    heading: "Your veterinary services",
    description: "List the consultations, vaccinations and farm visits you offer, so farmers know what you charge.",
  },
  "non-vet-specialist": {
    heading: "Your specialist services",
    description: "List the advisory and technical services you offer, so farmers know what you charge.",
  },
};

export const SERVICE_LIMITS = {
  name: { min: 3, max: 80 },
  description: { min: 10, max: 500 },
  /** whole naira */
  maxPriceNgn: 10_000_000,
  /** services (not counting removed ones) one account can list */
  perOwner: 50,
  /** marketplace services: what's included, excluded and what the customer must provide */
  note: 300,
} as const;

/** Durations a service can be listed with; null means "varies". */
export const DURATION_OPTIONS = [
  { minutes: 15, label: "15 mins" },
  { minutes: 30, label: "30 mins" },
  { minutes: 45, label: "45 mins" },
  { minutes: 60, label: "1 hour" },
  { minutes: 90, label: "1 hr 30 mins" },
  { minutes: 120, label: "2 hours" },
  { minutes: 180, label: "3 hours" },
  { minutes: 240, label: "4 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 480, label: "Full day (8 hours)" },
  { minutes: 1440, label: "24 hours" },
] as const;

export const DURATION_VARIES_LABEL = "Varies";

export function offersServices(role: Role): boolean {
  return SERVICE_CATEGORIES[role].length > 0;
}

export function serviceCategory(role: Role, value: string): ServiceCategory | undefined {
  return SERVICE_CATEGORIES[role].find((c) => c.value === value);
}

/** The label for a stored category, even one this role no longer offers. */
export function categoryLabel(role: Role, value: string): string {
  return serviceCategory(role, value)?.label ?? "Other";
}

export function isListedDuration(minutes: number): boolean {
  return DURATION_OPTIONS.some((d) => d.minutes === minutes);
}

export function durationLabel(minutes: number | null): string {
  if (minutes === null) return DURATION_VARIES_LABEL;
  return DURATION_OPTIONS.find((d) => d.minutes === minutes)?.label ?? `${minutes} mins`;
}

/**
 * ₦12,500 — formatted by hand so the server render and the browser always
 * agree (Intl output differs between ICU builds).
 */
export function formatNaira(amount: number): string {
  if (amount === 0) return "Free";
  return `₦${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** How a marketplace service is priced: a fixed price paid when booking, or a quote from the provider. */
export const SERVICE_PRICING = [
  { value: "fixed", label: "Fixed price" },
  { value: "quote", label: "Quote on request" },
] as const;
export type ServicePricing = (typeof SERVICE_PRICING)[number]["value"];
export const isServicePricing = (value: unknown): value is ServicePricing =>
  SERVICE_PRICING.some((p) => p.value === value);

/** Only an active service that's also open for booking can ever be booked. */
export function isBookable(service: { active: boolean; bookingAvailable: boolean }): boolean {
  return service.active && service.bookingAvailable;
}
