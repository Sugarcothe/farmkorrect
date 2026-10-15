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
};

export const SERVICE_CATEGORIES: Record<Role, readonly ServiceCategory[]> = {
  // farm services and advice shared with other farmers — not products for
  // sale and not flock records, which belong to other parts of the app
  "poultry-farmer": [
    { value: "farm-advisory", label: "Farm Advisory & Mentoring", allowsFree: true },
    { value: "training-farm-visit", label: "Training & Farm Visits", allowsFree: true },
    { value: "brooding-rearing", label: "Brooding & Rearing", allowsFree: false },
    { value: "bird-processing", label: "Bird Processing & Dressing", allowsFree: false },
    { value: "equipment-hire", label: "Equipment Hire", allowsFree: false },
  ],
  veterinarian: [
    { value: "consultation", label: "Consultation", allowsFree: true },
    { value: "vaccination", label: "Vaccination", allowsFree: false },
    { value: "biosecurity-audit", label: "Biosecurity Audit", allowsFree: false },
    { value: "disease-advisory", label: "Disease Diagnosis & Advisory", allowsFree: true },
    { value: "flock-health-check", label: "Routine Flock Health Check", allowsFree: false },
    { value: "post-mortem", label: "Post-mortem & Lab Referral", allowsFree: false },
    { value: "emergency-visit", label: "Emergency Farm Visit", allowsFree: false },
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

/** Only an active service that's also open for booking can ever be booked. */
export function isBookable(service: { active: boolean; bookingAvailable: boolean }): boolean {
  return service.active && service.bookingAvailable;
}
