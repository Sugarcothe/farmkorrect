import type { IconName } from "@/components/ui/icons";
import { addDays, lagosDate, lagosMinute, weekday } from "@/lib/vets/schedule";

/**
 * What the signed-in user may do as a provider or seller, worked out on the
 * server from the session's role and their own records (see
 * lib/server/dashboard.ts). The same rules the destination pages enforce.
 */
export type DashboardAccess = {
  /** veterinarians: Find a Vet appointments, availability and earnings */
  vetPractice: boolean;
  /** takes Other Services bookings */
  serviceProvider: boolean;
  /** lists products in the marketplace */
  seller: boolean;
};

export type DashboardAction = {
  key: string;
  title: string;
  description: string;
  href: string;
  icon: IconName;
};

const action = (key: string, title: string, description: string, href: string, icon: IconName): DashboardAction => ({
  key,
  title,
  description,
  href,
  icon,
});

export const DASHBOARD_ACTIONS = {
  vetJobs: action("vet-jobs", "Jobs", "Appointments booked with you", "/jobs", "briefcase"),
  availability: action("availability", "Availability", "Set the hours you can be booked", "/availability", "clock"),
  earnings: action("earnings", "Earnings", "What you've earned and can withdraw", "/wallet/earnings", "wallet"),
  serviceJobs: action(
    "service-jobs",
    "Service Jobs",
    "Bookings for the services you offer",
    "/services/jobs",
    "briefcase",
  ),
  myServices: action("my-services", "My Services", "Add and price your services", "/profile/services", "list"),
  myListings: action("my-listings", "My Listings", "Manage the products you sell", "/market/listings", "plus-square"),
  findVet: action("find-vet", "Find a Vet", "Book a vet for your farm", "/vets", "stethoscope"),
  appointments: action("appointments", "My Appointments", "Vet visits you've booked", "/appointments", "calendar"),
  services: action("services", "Other Services", "Fumigation, transport, installation and more", "/services", "wrench"),
  serviceBookings: action(
    "service-bookings",
    "My Service Bookings",
    "Track services you've booked",
    "/services/bookings",
    "file-text",
  ),
  market: action("market", "Marketplace", "Buy farm products and supplies", "/market", "store"),
  training: action("training", "Training Academy", "Courses for your farm and work", "/training", "graduation-cap"),
} as const;

/**
 * The Quick Actions for this user: their own work first, then what everyone
 * can use. Each destination appears once.
 */
export function dashboardActions(access: DashboardAccess): DashboardAction[] {
  const a = DASHBOARD_ACTIONS;
  const own: DashboardAction[] = [
    ...(access.vetPractice ? [a.vetJobs, a.availability, a.earnings] : []),
    ...(access.serviceProvider ? [a.serviceJobs, a.myServices] : []),
    ...(access.seller ? [a.myListings] : []),
  ];
  const common = [a.findVet, a.appointments, a.services, a.serviceBookings, a.market, a.training];
  const seen = new Set<string>();
  return [...own, ...common].filter((x) => !seen.has(x.href) && seen.add(x.href));
}

/** "Good morning" and so on, by the time in Lagos. */
export function greetingFor(now: Date): string {
  const hour = Math.floor(lagosMinute(now) / 60);
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Today and the current week (Monday to Sunday) as Lagos dates. */
export function dashboardDays(now: Date) {
  const today = lagosDate(now);
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  return {
    today,
    tomorrow: addDays(today, 1),
    weekStart: monday,
    weekEnd: addDays(monday, 6),
    nextWeekStart: addDays(monday, 7),
  };
}

/**
 * A provider's job counts. A "job" is a booking the provider has accepted
 * (confirmed, under way or completed), counted by the day it's booked for.
 */
export type DashboardStats = {
  source: "appointments" | "service_bookings";
  today: number;
  thisWeek: number;
  /** all time */
  completed: number;
  /** requests the provider still has to answer */
  awaitingReply: number;
};

/** null: this user has no provider figures; "unavailable": they couldn't be read. */
export type DashboardStatsResult = DashboardStats | "unavailable" | null;
