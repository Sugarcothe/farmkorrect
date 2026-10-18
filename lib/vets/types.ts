import type { NigerianState } from "@/lib/locations/nigeria";

// Public shapes for Find a Vet (the `data` of an ApiResult), shared by the
// browser and the server. Nothing here carries a phone number, registration
// number, qualification document or internal note: those stay on the server.
// See docs/find-vet.md.

// --- the directory ------------------------------------------------------------

export const DIRECTORY_SORTS = [
  { value: "experience", label: "Most experienced" },
  { value: "name", label: "Name (A–Z)" },
] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number]["value"];

export const DIRECTORY_PAGE_SIZE = 12;
export const DIRECTORY_MAX_PAGE_SIZE = 24;

/** The filters and sort of one directory search, already validated. */
export type DirectoryQuery = {
  /** free text over name, specialization, service types and service area */
  q: string;
  state: NigerianState | null;
  /** a veterinarian specialization value */
  specialty: string | null;
  /** a veterinarian service category value */
  service: string | null;
  /** YYYY-MM-DD (Lagos): the vet's hours include that weekday and it isn't blocked */
  date: string | null;
  sort: DirectorySort;
};

/** One vet in the directory. Only details the vet chose to list. */
export type VetCard = {
  id: string;
  name: string;
  photoUrl: string | null;
  specialization: string | null;
  yearsOfExperience: number | null;
  state: NigerianState | null;
  area: string;
  /** service category labels of their bookable services */
  serviceTypes: string[];
  /** cheapest bookable service, in whole naira (0 = a free service is offered) */
  priceFromNgn: number | null;
  /** the first slot still open in the next 14 days, if any was found */
  nextOpenSlot: string | null;
};

export type DirectoryPage = {
  vets: VetCard[];
  /** pass back as `cursor` with the same filters for the next page; null at the end */
  nextCursor: string | null;
};

// --- a vet's profile ----------------------------------------------------------

export type VetService = {
  id: string;
  name: string;
  categoryLabel: string;
  description: string;
  priceNgn: number;
  /** null when the duration varies */
  durationMinutes: number | null;
};

export type VetProfile = {
  id: string;
  name: string;
  photoUrl: string | null;
  bio: string;
  specialization: string | null;
  yearsOfExperience: number | null;
  state: NigerianState | null;
  area: string;
  workingHours: WeeklyHours;
  /** only bookable services (active and open for booking) */
  services: VetService[];
  nextOpenSlot: string | null;
};

// --- availability -------------------------------------------------------------

/** Minutes after midnight (Lagos), on a 30-minute grid. */
export type DayHours = { day: number; start: number; end: number };
export type WeeklyHours = DayHours[];

export const SLOT_OPTIONS = [30, 60] as const;
export type SlotMinutes = (typeof SLOT_OPTIONS)[number];

/** What a vet sets under Availability. */
export type AvailabilitySettings = {
  listed: boolean;
  state: NigerianState | null;
  area: string;
  hours: WeeklyHours;
  slotMinutes: SlotMinutes;
  /** YYYY-MM-DD days off (today or later) */
  blockedDates: string[];
  /** show the vet's phone number to customers whose appointment they accepted */
  sharePhoneWithClients: boolean;
};

export type AvailabilityResponse = {
  settings: AvailabilitySettings;
  /** why the vet isn't in the directory, if they aren't; empty when listed */
  listingIssues: string[];
};

export type SlotDay = { date: string; slots: string[] };
export type SlotsResponse = { days: SlotDay[] };

// --- appointments -------------------------------------------------------------

export const BOOKING_STATUSES = [
  "requested",
  "confirmed",
  "en_route",
  "in_progress",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Kept apart from the booking: the app doesn't collect payment for
 * appointments (see docs/find-vet.md), so a priced service stays
 * "payment_required" and is never shown as paid.
 */
export type AppointmentPaymentStatus = "not_required" | "payment_required";

export type AppointmentAction = "accept" | "decline" | "en_route" | "start" | "complete" | "cancel";

export type AppointmentActor = "customer" | "vet" | "system";

export type AppointmentLocation = {
  farmName: string;
  address: string;
  state: NigerianState;
  directions: string;
};

export type AppointmentHistoryItem = { status: BookingStatus; by: AppointmentActor; at: string; note: string | null };

export type Appointment = {
  id: string;
  reference: string;
  viewer: "customer" | "vet";
  vet: { id: string; name: string; photoUrl: string | null; phone: string | null };
  /** the customer's phone only reaches the vet once they've accepted */
  customer: { name: string; phone: string | null };
  service: { name: string; categoryLabel: string; durationMinutes: number | null };
  startsAt: string;
  endsAt: string;
  location: AppointmentLocation;
  priceKobo: number;
  feeKobo: number;
  totalKobo: number;
  bookingStatus: BookingStatus;
  paymentStatus: AppointmentPaymentStatus;
  /** when an unanswered request lapses */
  respondBy: string;
  history: AppointmentHistoryItem[];
  /** what this viewer may do now (the server checks again) */
  actions: AppointmentAction[];
  /** the customer may cancel a confirmed visit until then */
  cancelUntil: string;
  createdAt: string;
};

export type AppointmentSummary = Pick<
  Appointment,
  "id" | "reference" | "viewer" | "startsAt" | "bookingStatus" | "paymentStatus" | "totalKobo"
> & { otherParty: string; serviceName: string };

export type AppointmentResponse = { appointment: Appointment };
export type AppointmentListResponse = { appointments: AppointmentSummary[]; nextCursor: string | null };

export type AppointmentCreateRequest = {
  serviceId: string;
  startsAt: string;
  farmId?: string | null;
  location: Omit<AppointmentLocation, "farmName"> & { farmName?: string };
  idempotencyKey: string;
};

export type AppointmentTransitionRequest = {
  action: AppointmentAction;
  /** the status the viewer last saw; a different current status is a 409 */
  expectedStatus: BookingStatus;
  reason?: string;
};

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  requested: "Waiting for the vet",
  confirmed: "Accepted by the vet",
  en_route: "Vet on the way",
  in_progress: "In progress",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Not answered in time",
};

export const OPEN_BOOKING_STATUSES: readonly BookingStatus[] = ["requested", "confirmed", "en_route", "in_progress"];

/**
 * "Booking Confirmed" is only ever shown when the vet has accepted *and*
 * nothing is left to pay. A priced service is never shown as confirmed,
 * because the app hasn't collected its payment.
 */
export function isFullyConfirmed(a: Pick<Appointment, "bookingStatus" | "paymentStatus">): boolean {
  return (
    ["confirmed", "en_route", "in_progress", "completed"].includes(a.bookingStatus) && a.paymentStatus === "not_required"
  );
}
