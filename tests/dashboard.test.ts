import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard } from "@/components/home/dashboard";
import {
  dashboardActions,
  dashboardDays,
  greetingFor,
  type DashboardAccess,
  type DashboardStatsResult,
} from "@/lib/home/dashboard";
import { PROFILE_CONFIG } from "@/lib/profile/config";
import { getDb } from "@/lib/server/db";
import { dashboardAccess, dashboardStats, dashboardSubtitle } from "@/lib/server/dashboard";
import { COLLECTIONS, type UserDoc } from "@/lib/server/models";
import { lagosInstant, weekday } from "@/lib/vets/schedule";
import { userByPhone } from "./support/db";
import { newRegistration, registerVerified, registerWithFarm } from "./support/flows";

const NONE: DashboardAccess = { vetPractice: false, serviceProvider: false, seller: false };
const COMMON = ["/vets", "/appointments", "/services", "/services/bookings", "/market", "/training"];
// Wednesday 21 October 2026, 10:00 in Lagos
const NOW = new Date("2026-10-21T09:00:00Z");

async function account(role: UserDoc["role"], withFarm = false) {
  const input = newRegistration({ role });
  await (withFarm ? registerWithFarm(input) : registerVerified(input));
  return (await userByPhone(input.phone))!;
}

const hrefs = (access: DashboardAccess) => dashboardActions(access).map((a) => a.href);

describe("quick actions", () => {
  it("gives customers only the common actions, with their routes", () => {
    expect(hrefs(NONE)).toEqual(COMMON);
  });

  it("puts a vet's own work first", () => {
    expect(hrefs({ ...NONE, vetPractice: true })).toEqual(["/jobs", "/availability", "/wallet/earnings", ...COMMON]);
  });

  it("gives service providers their jobs and services", () => {
    expect(hrefs({ ...NONE, serviceProvider: true })).toEqual(["/services/jobs", "/profile/services", ...COMMON]);
  });

  it("gives sellers their listings", () => {
    expect(hrefs({ ...NONE, seller: true })).toEqual(["/market/listings", ...COMMON]);
    expect(hrefs({ ...NONE, seller: true, serviceProvider: true })).toEqual([
      "/services/jobs",
      "/profile/services",
      "/market/listings",
      ...COMMON,
    ]);
  });

  it("never repeats a destination and gives every card a title, description and icon", () => {
    const all = dashboardActions({ vetPractice: true, serviceProvider: true, seller: true });
    expect(new Set(all.map((a) => a.href)).size).toBe(all.length);
    expect(new Set(all.map((a) => a.key)).size).toBe(all.length);
    for (const a of all) {
      expect(a.title).toBeTruthy();
      expect(a.description).toBeTruthy();
      expect(a.icon).toBeTruthy();
    }
  });
});

describe("dashboard access from the user's own role and records", () => {
  it("vets get the vet practice shortcuts only", async () => {
    const vet = await account("veterinarian");
    expect(await dashboardAccess(vet)).toEqual({ vetPractice: true, serviceProvider: false, seller: false });
  });

  it("specialists are service providers", async () => {
    const specialist = await account("non-vet-specialist");
    expect(await dashboardAccess(specialist)).toEqual({ vetPractice: false, serviceProvider: true, seller: false });
  });

  it("farmers are sellers, and service providers once they offer an Other Service", async () => {
    const farmer = await account("poultry-farmer", true);
    expect(await dashboardAccess(farmer)).toEqual({ vetPractice: false, serviceProvider: false, seller: true });

    const services = (await getDb()).collection(COLLECTIONS.services);
    // an archived service and someone else's don't count
    await services.insertOne({ ownerUserId: farmer._id, archivedAt: new Date(), pricing: "fixed" } as never);
    await services.insertOne({ ownerUserId: new ObjectId(), archivedAt: null, pricing: "fixed" } as never);
    expect((await dashboardAccess(farmer)).serviceProvider).toBe(false);

    await services.insertOne({ ownerUserId: farmer._id, archivedAt: null, pricing: "fixed" } as never);
    expect(await dashboardAccess(farmer)).toEqual({ vetPractice: false, serviceProvider: true, seller: true });
  });
});

describe("dashboard figures", () => {
  it("has a Monday-to-Sunday week in Lagos time", () => {
    const days = dashboardDays(NOW);
    expect(days.today).toBe("2026-10-21");
    expect(weekday(days.weekStart)).toBe(1);
    expect(days.weekStart).toBe("2026-10-19");
    expect(days.weekEnd).toBe("2026-10-25");
    expect(days.nextWeekStart).toBe("2026-10-26");
    // Sunday still belongs to the week that began on Monday
    expect(dashboardDays(new Date("2026-10-25T20:00:00Z")).weekStart).toBe("2026-10-19");
  });

  it("counts only the vet's own appointments", async () => {
    const vet = await account("veterinarian");
    const other = await account("veterinarian");
    const appointments = (await getDb()).collection(COLLECTIONS.appointments);
    const at = (date: string, hour: number) => lagosInstant(date, hour * 60);
    const later = new Date(NOW.getTime() + 3_600_000);
    const earlier = new Date(NOW.getTime() - 3_600_000);
    const appt = (vetUserId: ObjectId, bookingStatus: string, startsAt: Date, respondBy = later) =>
      ({
        reference: new ObjectId().toHexString(),
        idempotencyKey: new ObjectId().toHexString(),
        vetUserId,
        bookingStatus,
        startsAt,
        respondBy,
      }) as never;
    await appointments.insertMany([
      appt(vet._id, "confirmed", at("2026-10-21", 14)), // today
      appt(vet._id, "in_progress", at("2026-10-21", 9)), // today
      appt(vet._id, "confirmed", at("2026-10-25", 16)), // Sunday, this week
      appt(vet._id, "completed", at("2026-10-19", 8)), // Monday, this week
      appt(vet._id, "completed", at("2026-09-01", 8)), // completed long ago
      appt(vet._id, "confirmed", at("2026-10-26", 8)), // next week
      appt(vet._id, "declined", at("2026-10-21", 15)), // not accepted
      appt(vet._id, "requested", at("2026-10-22", 10)), // awaiting reply
      appt(vet._id, "requested", at("2026-10-22", 11), earlier), // reply window over
      // another vet's: none of these count
      appt(other._id, "confirmed", at("2026-10-21", 10)),
      appt(other._id, "completed", at("2026-10-20", 10)),
      appt(other._id, "requested", at("2026-10-22", 10)),
    ]);

    expect(await dashboardStats(vet, { ...NONE, vetPractice: true }, NOW)).toEqual({
      source: "appointments",
      today: 2,
      thisWeek: 4,
      completed: 2,
      awaitingReply: 1,
    });
    expect(await dashboardStats(other, { ...NONE, vetPractice: true }, NOW)).toEqual({
      source: "appointments",
      today: 1,
      thisWeek: 2,
      completed: 1,
      awaitingReply: 1,
    });
  });

  it("counts only the provider's own service bookings", async () => {
    const provider = await account("non-vet-specialist");
    const other = await account("non-vet-specialist");
    const bookings = (await getDb()).collection(COLLECTIONS.serviceBookings);
    const later = new Date(NOW.getTime() + 3_600_000);
    const booking = (providerUserId: ObjectId, status: string, date: string, respondBy = later) =>
      ({
        reference: new ObjectId().toHexString(),
        idempotencyKey: new ObjectId().toHexString(),
        providerUserId,
        status,
        schedule: { date },
        respondBy,
      }) as never;
    await bookings.insertMany([
      booking(provider._id, "confirmed", "2026-10-21"),
      booking(provider._id, "provider_en_route", "2026-10-21"),
      booking(provider._id, "completed", "2026-10-25"),
      booking(provider._id, "completed", "2026-08-02"),
      booking(provider._id, "cancelled", "2026-10-21"),
      booking(provider._id, "confirmed", "2026-10-18"), // the Sunday before
      booking(provider._id, "requested", "2026-10-23"),
      booking(other._id, "confirmed", "2026-10-21"),
      booking(other._id, "requested", "2026-10-23"),
    ]);

    expect(await dashboardStats(provider, { ...NONE, serviceProvider: true }, NOW)).toEqual({
      source: "service_bookings",
      today: 2,
      thisWeek: 3,
      completed: 2,
      awaitingReply: 1,
    });
  });

  it("are zero, not invented, for a provider with no jobs yet", async () => {
    const vet = await account("veterinarian");
    expect(await dashboardStats(vet, { ...NONE, vetPractice: true }, NOW)).toEqual({
      source: "appointments",
      today: 0,
      thisWeek: 0,
      completed: 0,
      awaitingReply: 0,
    });
  });

  it("are left out for customers", async () => {
    const farmer = await account("poultry-farmer");
    expect(await dashboardStats(farmer, { ...NONE, seller: true }, NOW)).toBeNull();
  });
});

describe("dashboard subtitle", () => {
  it("shows the farmer's own farm", async () => {
    expect(await dashboardSubtitle(await account("poultry-farmer", true))).toBe(
      "Poultry Farmer · Alao Poultry Enterprises",
    );
    expect(await dashboardSubtitle(await account("poultry-farmer"))).toBe("Poultry Farmer");
  });

  it("shows a provider's specialization only when they've set one", async () => {
    const vet = await account("veterinarian");
    const title = PROFILE_CONFIG.veterinarian.title;
    expect(await dashboardSubtitle(vet)).toBe(title);
    const withSpecialization = { ...vet, profile: { ...vet.profile, specialization: "avian-pathology" } } as UserDoc;
    expect(await dashboardSubtitle(withSpecialization)).toBe(`${title} · Avian Pathology`);
  });
});

describe("greeting", () => {
  it("follows the time in Lagos", () => {
    expect(greetingFor(new Date("2026-10-21T06:00:00Z"))).toBe("Good morning");
    expect(greetingFor(new Date("2026-10-21T10:59:00Z"))).toBe("Good morning");
    expect(greetingFor(new Date("2026-10-21T11:00:00Z"))).toBe("Good afternoon");
    expect(greetingFor(new Date("2026-10-21T16:00:00Z"))).toBe("Good evening");
    expect(greetingFor(new Date("2026-10-21T23:30:00Z"))).toBe("Good morning");
  });
});

describe("dashboard view", () => {
  const render = (stats: DashboardStatsResult, access: DashboardAccess = NONE) =>
    renderToStaticMarkup(
      createElement(Dashboard, {
        greeting: "Good morning",
        name: "Chidinma Eze",
        subtitle: "Veterinarian · Avian Pathology",
        stats,
        actions: dashboardActions(access),
        bell: createElement("span", null, "bell"),
      }),
    );

  it("shows the name, role and Quick Actions as links, with no placeholder", () => {
    const html = render(null);
    expect(html).toContain("Good morning,");
    expect(html).toContain("Chidinma Eze");
    expect(html).toContain("Veterinarian · Avian Pathology");
    expect(html).toContain("Quick Actions");
    for (const href of COMMON) expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/jobs"');
    expect(html).not.toMatch(/coming soon|hatching/i);
    // customers see no figures at all
    expect(html).not.toContain("Today&#x27;s jobs");
    expect(html).not.toMatch(/rating/i);
  });

  it("shows the role's own actions", () => {
    const html = render(null, { ...NONE, vetPractice: true });
    for (const href of ["/jobs", "/availability", "/wallet/earnings"]) expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/market/listings"');
  });

  it("shows the real figures, not sample ones", () => {
    const html = render(
      { source: "appointments", today: 7, thisWeek: 19, completed: 41, awaitingReply: 2 },
      { ...NONE, vetPractice: true },
    );
    for (const value of ["7", "19", "41", "2"]) expect(html).toContain(`>${value}</dd>`);
    expect(html).not.toMatch(/>(3|12|156|4\.8)<\/dd>/);
    expect(html).toContain('href="/jobs"');
  });

  it("says when the figures couldn't be loaded instead of showing zeros", () => {
    const html = render("unavailable", { ...NONE, vetPractice: true });
    expect(html).toContain("couldn’t be loaded");
    expect(html).not.toContain("<dd");
    expect(html).toContain('href="/availability"');
  });

  it("has no hardcoded figures or placeholder left in the home page", () => {
    const page = readFileSync("app/(app)/home/page.tsx", "utf8");
    expect(page).not.toMatch(/coming-soon|ComingSoon|hatching/i);
    expect(page).not.toMatch(/\b(156|4\.8)\b/);
    expect(page).toContain("requireVerifiedPageSession");
  });
});

describe("navigation", () => {
  it("is unchanged", () => {
    const tabs = (role: UserDoc["role"]) => PROFILE_CONFIG[role].tabs.map((t) => t.href);
    expect(tabs("poultry-farmer")).toEqual(["/home", "/market", "/services", "/training", "/wallet", "/profile"]);
    expect(tabs("veterinarian")).toEqual(["/home", "/jobs", "/availability", "/wallet", "/profile"]);
    expect(tabs("non-vet-specialist")).toEqual(["/home", "/services/jobs", "/services", "/wallet", "/profile"]);
  });
});
