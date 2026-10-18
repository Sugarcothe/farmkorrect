import "server-only";
import { dashboardDays, type DashboardAccess, type DashboardStats } from "@/lib/home/dashboard";
import { PROFILE_CONFIG, specializationLabel } from "@/lib/profile/config";
import { MARKETPLACE_ROLES } from "@/lib/services/config";
import type { ServiceBookingStatus } from "@/lib/services/marketplace";
import type { BookingStatus } from "@/lib/vets/types";
import { lagosInstant } from "@/lib/vets/schedule";
import { getDb } from "./db";
import { findInitialFarm } from "./farms";
import { COLLECTIONS, type AppointmentDoc, type ServiceBookingDoc, type ServiceDoc, type UserDoc } from "./models";
import { SELLER_ROLE } from "./products";

// The signed-in home dashboard. Everything here is read for the session's
// own user: the role comes from the session, never from the request, and
// every query is filtered on the user's id. Counts are index-backed
// countDocuments calls, never documents loaded to be counted.

/** Accepted jobs: the provider took them on (or finished them). */
const ACCEPTED_APPOINTMENTS: BookingStatus[] = ["confirmed", "en_route", "in_progress", "completed"];
const ACCEPTED_SERVICE_BOOKINGS: ServiceBookingStatus[] = [
  "confirmed",
  "provider_en_route",
  "in_progress",
  "completed",
];

/**
 * Which provider and seller shortcuts apply. Specialists whose navigation is
 * built around service jobs always get them; anyone else whose role may
 * offer Other Services gets them once they've added one.
 */
export async function dashboardAccess(user: Pick<UserDoc, "_id" | "role">): Promise<DashboardAccess> {
  const vetPractice = user.role === "veterinarian";
  let serviceProvider = false;
  if (MARKETPLACE_ROLES[user.role].length > 0) {
    serviceProvider =
      PROFILE_CONFIG[user.role].tabs.some((t) => t.href === "/services/jobs") ||
      // unreadable: leave the shortcuts out (they stay reachable from Profile and Services)
      (await hasMarketplaceService(user).catch((error: unknown) => {
        console.error(`[home] service lookup failed: ${error instanceof Error ? error.name : typeof error}`);
        return false;
      }));
  }
  return { vetPractice, serviceProvider, seller: user.role === SELLER_ROLE };
}

async function hasMarketplaceService(user: Pick<UserDoc, "_id">) {
  const db = await getDb();
  const found = await db
    .collection<ServiceDoc>(COLLECTIONS.services)
    .findOne({ ownerUserId: user._id, archivedAt: null, pricing: { $type: "string" } }, { projection: { _id: 1 } });
  return found !== null;
}

/**
 * The provider's job counts, or null when they have none to show (customers
 * only). Throws if the database can't be read; the page shows that the
 * figures are unavailable rather than zeros.
 */
export async function dashboardStats(
  user: Pick<UserDoc, "_id">,
  access: DashboardAccess,
  now = new Date(),
): Promise<DashboardStats | null> {
  const days = dashboardDays(now);
  const db = await getDb();
  if (access.vetPractice) {
    const appointments = db.collection<AppointmentDoc>(COLLECTIONS.appointments);
    const accepted = { vetUserId: user._id, bookingStatus: { $in: ACCEPTED_APPOINTMENTS } };
    const between = (from: string, to: string) => ({ $gte: lagosInstant(from, 0), $lt: lagosInstant(to, 0) });
    const [today, thisWeek, completed, awaitingReply] = await Promise.all([
      appointments.countDocuments({ ...accepted, startsAt: between(days.today, days.tomorrow) }),
      appointments.countDocuments({ ...accepted, startsAt: between(days.weekStart, days.nextWeekStart) }),
      appointments.countDocuments({ vetUserId: user._id, bookingStatus: "completed" }),
      appointments.countDocuments({ vetUserId: user._id, bookingStatus: "requested", respondBy: { $gt: now } }),
    ]);
    return { source: "appointments", today, thisWeek, completed, awaitingReply };
  }
  if (access.serviceProvider) {
    const bookings = db.collection<ServiceBookingDoc>(COLLECTIONS.serviceBookings);
    const accepted = { providerUserId: user._id, status: { $in: ACCEPTED_SERVICE_BOOKINGS } };
    const [today, thisWeek, completed, awaitingReply] = await Promise.all([
      bookings.countDocuments({ ...accepted, "schedule.date": days.today }),
      bookings.countDocuments({ ...accepted, "schedule.date": { $gte: days.weekStart, $lte: days.weekEnd } }),
      bookings.countDocuments({ providerUserId: user._id, status: "completed" }),
      bookings.countDocuments({ providerUserId: user._id, status: "requested", respondBy: { $gt: now } }),
    ]);
    return { source: "service_bookings", today, thisWeek, completed, awaitingReply };
  }
  return null;
}

/** The line under the name: the user's own specialization or farm, else their role. */
export async function dashboardSubtitle(user: UserDoc): Promise<string> {
  const title = PROFILE_CONFIG[user.role].title;
  if (user.role === "poultry-farmer") {
    const farm = await findInitialFarm(user._id);
    return farm?.farmName ? `${title} · ${farm.farmName}` : title;
  }
  const specialization = specializationLabel(user.role, user.profile?.specialization ?? "");
  return specialization ? `${title} · ${specialization}` : title;
}
