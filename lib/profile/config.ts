import type { Role } from "@/lib/auth/types";
import type { ProfileField } from "./types";

// What the Profile screens show for each role. The screens, the API and the
// validators all read this one table, so a role's editable fields, menu and
// tabs are defined in exactly one place. The role itself always comes from
// the signed-in account on the server.

export type Option = { value: string; label: string };

export const SPECIALIZATIONS: Record<Exclude<Role, "poultry-farmer">, readonly Option[]> = {
  veterinarian: [
    { value: "poultry-medicine", label: "Poultry Medicine" },
    { value: "avian-pathology", label: "Avian Pathology" },
    { value: "hatchery-breeder-health", label: "Hatchery & Breeder Health" },
    { value: "vaccination-biosecurity", label: "Vaccination & Biosecurity" },
    { value: "general-practice", label: "General Veterinary Practice" },
  ],
  "non-vet-specialist": [
    { value: "poultry-nutrition", label: "Poultry Nutrition" },
    { value: "farm-management", label: "Farm Management" },
    { value: "hatchery-operations", label: "Hatchery Operations" },
    { value: "biosecurity-consulting", label: "Biosecurity Consulting" },
    { value: "housing-equipment", label: "Housing & Equipment" },
    { value: "processing-marketing", label: "Processing & Marketing" },
  ],
};

/**
 * Profile sub-pages. Those not marked `ready` aren't built yet and show an
 * honest "coming soon"; ready ones have their own route.
 */
export type ProfileSection =
  | "reviews"
  | "services"
  | "bank-details"
  | "notifications"
  | "security"
  | "certification"
  | "help";

export const SECTION_INFO: Record<ProfileSection, { title: string; icon: MenuIcon; blurb: string; ready?: true }> = {
  reviews: {
    title: "My Reviews",
    icon: "star",
    blurb: "Reviews from farmers you've worked with will appear here once bookings open.",
  },
  services: {
    title: "Services & Pricing",
    icon: "list",
    blurb: "List the services you offer and what you charge.",
    ready: true,
  },
  "bank-details": {
    title: "Bank Details",
    icon: "landmark",
    blurb: "Add the bank account your earnings will be paid into, verified with Paystack.",
    ready: true,
  },
  notifications: {
    title: "Notifications",
    icon: "bell",
    blurb: "Choose which alerts you get by SMS and in the app. Coming soon.",
  },
  security: {
    title: "Security Settings",
    icon: "lock",
    blurb: "Password changes and signed-in devices will be managed here. Until then, use “Forgot password” on the login screen.",
  },
  certification: {
    title: "Certification",
    icon: "award",
    blurb: "Upload certificates for review here. Credentials are only marked verified after our team checks them.",
  },
  help: {
    title: "Help & Support",
    icon: "help-circle",
    blurb: "FAQs and in-app support are on the way.",
  },
};

export type MenuIcon =
  | "pencil"
  | "star"
  | "list"
  | "landmark"
  | "bell"
  | "lock"
  | "award"
  | "help-circle";

export type NavTab = {
  label: string;
  icon: "home" | "briefcase" | "calendar" | "wallet" | "user" | "store" | "graduation-cap";
  /** null while that area isn't built; the tab shows as "Soon" and is disabled */
  href: string | null;
};

type RoleProfileConfig = {
  /** shown under the name when there's no specialization */
  title: string;
  editableFields: readonly ProfileField[];
  /** sub-pages in the order the menu lists them (Edit Profile and Log Out are always present) */
  sections: readonly ProfileSection[];
  tabs: readonly NavTab[];
  /** whether the role carries a professional credential that needs review */
  hasCredential: boolean;
};

const PROFESSIONAL_TABS: readonly NavTab[] = [
  { label: "Home", icon: "home", href: "/home" },
  { label: "Jobs", icon: "briefcase", href: null },
  { label: "Availability", icon: "calendar", href: null },
  { label: "Earnings", icon: "wallet", href: "/wallet" },
  { label: "Profile", icon: "user", href: "/profile" },
];

const FARMER_TABS: readonly NavTab[] = [
  { label: "Home", icon: "home", href: "/home" },
  { label: "Market", icon: "store", href: "/market" },
  { label: "Training", icon: "graduation-cap", href: null },
  { label: "Finances", icon: "wallet", href: "/wallet" },
  { label: "Profile", icon: "user", href: "/profile" },
];

const PROFESSIONAL_SECTIONS: readonly ProfileSection[] = [
  "reviews",
  "services",
  "bank-details",
  "notifications",
  "security",
  "certification",
  "help",
];

export const PROFILE_CONFIG: Record<Role, RoleProfileConfig> = {
  "poultry-farmer": {
    title: "Poultry Farmer",
    editableFields: [
      "fullName",
      "bio",
      "farmName",
      "location",
      "farmType",
      "birdCount",
      "yearsOfExperience",
    ],
    sections: ["services", "bank-details", "notifications", "security", "help"],
    tabs: FARMER_TABS,
    hasCredential: false,
  },
  veterinarian: {
    title: "Veterinarian",
    editableFields: [
      "fullName",
      "bio",
      "specialization",
      "yearsOfExperience",
      "location",
      "qualifications",
      "registrationNumber",
    ],
    sections: PROFESSIONAL_SECTIONS,
    tabs: PROFESSIONAL_TABS,
    hasCredential: true,
  },
  "non-vet-specialist": {
    title: "Non-Vet Specialist",
    editableFields: [
      "fullName",
      "bio",
      "specialization",
      "yearsOfExperience",
      "location",
      "qualifications",
    ],
    sections: PROFESSIONAL_SECTIONS,
    tabs: PROFESSIONAL_TABS,
    hasCredential: false,
  },
};

export function specializationLabel(role: Role, value: string): string {
  if (role === "poultry-farmer") return "";
  return SPECIALIZATIONS[role].find((o) => o.value === value)?.label ?? "";
}

export function isProfileSection(value: string): value is ProfileSection {
  return Object.hasOwn(SECTION_INFO, value);
}

/** Photo upload rules, shared by the picker and the API. */
export const PHOTO_RULES = {
  maxBytes: 5 * 1024 * 1024,
  types: ["image/jpeg", "image/png", "image/webp"] as const,
} as const;
