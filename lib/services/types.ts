import type { NigerianState } from "@/lib/locations/nigeria";
import type { ServicePricing } from "./config";

// Public shapes for the Services & Pricing API (the `data` of an ApiResult).
// The owner is never part of these: it is always the signed-in account.

export type Service = {
  id: string;
  name: string;
  category: string;
  description: string;
  /** whole naira; 0 means free */
  priceNgn: number;
  /** null when the duration varies */
  durationMinutes: number | null;
  /** listed on the provider's profile at all */
  active: boolean;
  /** the provider is taking bookings for it (only counts while active) */
  bookingAvailable: boolean;
  /** active && bookingAvailable */
  bookable: boolean;
  /** marketplace services only (null / empty otherwise) */
  pricing: ServicePricing | null;
  serviceStates: NigerianState[];
  included: string;
  excluded: string;
  requirements: string;
  createdAt: string;
  updatedAt: string;
};

export type ServiceFields = {
  name: string;
  category: string;
  description: string;
  priceNgn: number;
  durationMinutes: number | null;
  active: boolean;
  bookingAvailable: boolean;
} & Partial<MarketplaceFields>;

/**
 * Extra details a marketplace service (docs/other-services.md) carries.
 * Pricing and at least one state are required for those categories and
 * refused for every other one. A "quote" service is stored with price 0.
 */
export type MarketplaceFields = {
  pricing: ServicePricing;
  serviceStates: NigerianState[];
  included: string;
  excluded: string;
  requirements: string;
};

/** POST /api/services; `active` and `bookingAvailable` default to true. */
export type ServiceCreateRequest = Omit<ServiceFields, "active" | "bookingAvailable"> &
  Partial<Pick<ServiceFields, "active" | "bookingAvailable">>;

/** PATCH /api/services/[id]: any subset of the editable fields. */
export type ServiceUpdateRequest = Partial<ServiceFields>;

export type ServiceResponse = { service: Service };
export type ServicesResponse = { services: Service[] };
