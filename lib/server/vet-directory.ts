import "server-only";
import { ObjectId, type Filter, type Sort } from "mongodb";
import { stateLabel } from "@/lib/locations/nigeria";
import { specializationLabel } from "@/lib/profile/config";
import { categoryLabel, SERVICE_LIMITS } from "@/lib/services/config";
import { canonicalQuery, searchWords } from "@/lib/vets/query";
import { addDays, blockMinutes, lagosDate, openSlots, weekday } from "@/lib/vets/schedule";
import type { DirectoryPage, DirectoryQuery, VetCard, VetProfile } from "@/lib/vets/types";
import { getAuthConfig } from "./config";
import { hmac, safeEqualHex } from "./crypto";
import { getDb } from "./db";
import { HttpError } from "./http";
import {
  COLLECTIONS,
  type AppointmentDoc,
  type AppointmentSlotDoc,
  type ServiceDoc,
  type UserDoc,
  type VetAvailabilityDoc,
  type VetDirectoryDoc,
} from "./models";

// Find a Vet: who is listed, the directory search and a vet's public
// profile. The directory collection is a derived index (see VetDirectoryDoc):
// every page and every booking re-reads the account, services and settings
// it came from, so a stale entry can only affect who appears in a search,
// never what can be booked.

export async function vetCollections() {
  const db = await getDb();
  return {
    users: db.collection<UserDoc>(COLLECTIONS.users),
    services: db.collection<ServiceDoc>(COLLECTIONS.services),
    availability: db.collection<VetAvailabilityDoc>(COLLECTIONS.vetAvailability),
    directory: db.collection<VetDirectoryDoc>(COLLECTIONS.vetDirectory),
    appointments: db.collection<AppointmentDoc>(COLLECTIONS.appointments),
    slots: db.collection<AppointmentSlotDoc>(COLLECTIONS.appointmentSlots),
  };
}

export const VETS_UNVERIFIED = "Verify your phone number before using Find a Vet.";
export const VET_NOT_FOUND = "We couldn't find that vet. They may not be taking bookings right now.";

/** A strict 24-hex-digit id, or null. */
export const parseId = (id: unknown): ObjectId | null =>
  typeof id === "string" && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;

const VET_PROJECTION = { _id: 1, fullName: 1, role: 1, status: 1, profile: 1 } as const;

/** Bookable services of a vet, cheapest first (bounded by the per-owner limit). */
export async function bookableServices(vetUserId: ObjectId): Promise<ServiceDoc[]> {
  const { services } = await vetCollections();
  return services
    .find({ ownerUserId: vetUserId, archivedAt: null, active: true, bookingAvailable: true })
    .sort({ priceNgn: 1, _id: 1 })
    .limit(SERVICE_LIMITS.perOwner)
    .toArray();
}

/**
 * Why a vet isn't in the directory; empty when they are. A missing field
 * never counts as verified or set up: only an admin's approval makes
 * credentialStatus "verified".
 */
export function listingIssues(
  user: Pick<UserDoc, "role" | "status" | "profile"> | null,
  availability: VetAvailabilityDoc | null,
  services: readonly ServiceDoc[],
): string[] {
  if (!user || user.role !== "veterinarian" || user.status !== "active") return ["Only active veterinarian accounts are listed."];
  const issues: string[] = [];
  if (user.profile?.credentialStatus !== "verified")
    issues.push("Your credentials haven't been approved by the Farm Korret team yet.");
  if (!availability?.listed) issues.push("Turn on “Show me in Find a Vet”.");
  if (!availability?.state) issues.push("Choose the state you work in.");
  if (!availability?.hours.length) issues.push("Set working hours for at least one day.");
  if (services.length === 0) issues.push("Add a service that's active and open for booking under Services & Pricing.");
  return issues;
}

/**
 * Rebuilds one vet's directory entry from its sources. Safe to run any
 * number of times; anyone who isn't a veterinarian has no entry.
 */
export async function refreshVetDirectory(userId: ObjectId, now = new Date()): Promise<void> {
  const { users, availability, directory } = await vetCollections();
  const user = await users.findOne({ _id: userId, role: "veterinarian" }, { projection: VET_PROJECTION });
  if (!user) {
    await directory.deleteOne({ _id: userId });
    return;
  }
  const [settings, services] = await Promise.all([availability.findOne({ _id: userId }), bookableServices(userId)]);
  const listed = listingIssues(user, settings, services).length === 0;
  const p = user.profile ?? {};
  const specialization = p.specialization ? specializationLabel("veterinarian", p.specialization) || null : null;
  const categories = [...new Set(services.map((s) => s.category))];
  const slotMinutes = settings?.slotMinutes ?? 60;
  const words = new Set(
    searchWords(
      [
        user.fullName,
        specialization ?? "",
        ...categories.map((c) => categoryLabel("veterinarian", c)),
        settings?.state ? stateLabel(settings.state) : "",
        settings?.area ?? "",
      ].join(" "),
    ),
  );
  const doc: VetDirectoryDoc = {
    _id: userId,
    listed,
    name: user.fullName,
    nameKey: user.fullName.trim().toLowerCase(),
    photoUrl: p.photo?.url ?? null,
    specialization: p.specialization ?? null,
    yearsOfExperience: p.yearsOfExperience ?? null,
    experienceKey: p.yearsOfExperience ?? -1,
    state: settings?.state ?? null,
    area: settings?.area ?? "",
    serviceCategories: categories,
    priceFromNgn: services.length ? Math.min(...services.map((s) => s.priceNgn)) : null,
    minBlockMinutes: services.length
      ? Math.min(...services.map((s) => blockMinutes(s.durationMinutes, slotMinutes)))
      : slotMinutes,
    slotMinutes,
    hours: settings?.hours ?? [],
    searchWords: [...words].slice(0, 80),
    workDays: (settings?.hours ?? []).map((h) => h.day),
    blockedDates: settings?.blockedDates ?? [],
    refreshedAt: now,
  };
  await directory.replaceOne({ _id: userId }, doc, { upsert: true });
  if (settings) await availability.updateOne({ _id: userId }, { $set: { directoryRefreshedAt: now } });
}

/**
 * After a change to a vet's account, services or settings has committed.
 * Never throws: a failure is logged and the appointment job rebuilds the
 * entry later (it refreshes the oldest entries every run).
 */
export async function queueDirectoryRefresh(user: Pick<UserDoc, "_id" | "role">): Promise<void> {
  if (user.role !== "veterinarian") return;
  try {
    await refreshVetDirectory(user._id);
  } catch (error) {
    console.error(`[vets] directory refresh failed; the job will retry: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

/** Rebuilds the least recently refreshed entries (the appointment job). */
export async function refreshStaleDirectory(limit: number): Promise<number> {
  const { availability } = await vetCollections();
  const stale = await availability
    .find({}, { projection: { _id: 1 } })
    .sort({ directoryRefreshedAt: 1 })
    .limit(limit)
    .toArray();
  for (const { _id } of stale) await refreshVetDirectory(_id);
  return stale.length;
}

// --- open slots ---------------------------------------------------------------

/** Lookahead for the "next open slot" shown on cards and profiles. */
const NEXT_SLOT_DAYS = 14;

/** Epoch ms of every unit already held for these vets in [from, to). One query. */
export async function heldUnits(vetUserIds: ObjectId[], from: Date, to: Date): Promise<Map<string, Set<number>>> {
  const { slots } = await vetCollections();
  const out = new Map<string, Set<number>>(vetUserIds.map((id) => [id.toHexString(), new Set<number>()]));
  if (vetUserIds.length === 0) return out;
  const docs = await slots
    .find({ vetUserId: { $in: vetUserIds }, startsAt: { $gte: from, $lt: to } }, { projection: { vetUserId: 1, startsAt: 1 } })
    // 48 units a day per vet at most
    .limit(vetUserIds.length * 48 * (NEXT_SLOT_DAYS + 2))
    .toArray();
  for (const d of docs) out.get(d.vetUserId.toHexString())?.add(d.startsAt.getTime());
  return out;
}

type ScheduleSource = Pick<VetDirectoryDoc, "hours" | "slotMinutes" | "blockedDates">;

/** The first open start time in the next two weeks for a booking of `block` minutes. */
export function firstOpenSlot(schedule: ScheduleSource, block: number, taken: ReadonlySet<number>, now: Date): Date | null {
  const today = lagosDate(now);
  for (let i = 0; i <= NEXT_SLOT_DAYS; i++) {
    const found = openSlots(schedule, addDays(today, i), block, taken, now)[0];
    if (found) return found;
  }
  return null;
}

const lookahead = (now: Date) => ({ from: now, to: new Date(now.getTime() + (NEXT_SLOT_DAYS + 2) * 86_400_000) });

// --- the directory --------------------------------------------------------------

type CursorKey = { sort: DirectoryQuery["sort"]; key: number | string; id: string };

function cursorSignature(query: DirectoryQuery, payload: string) {
  return hmac(getAuthConfig().secret, "vet-directory-cursor", canonicalQuery(query), payload).slice(0, 32);
}

export function encodeCursor(query: DirectoryQuery, doc: Pick<VetDirectoryDoc, "_id" | "experienceKey" | "nameKey">): string {
  const key = query.sort === "name" ? doc.nameKey : doc.experienceKey;
  const payload = Buffer.from(JSON.stringify({ v: 1, k: key, i: doc._id.toHexString() })).toString("base64url");
  return `${payload}.${cursorSignature(query, payload)}`;
}

export const BAD_CURSOR = "This list has changed. Start the search again.";

/**
 * A cursor is only accepted with the exact filters and sort it was made for
 * (its signature covers them), and its contents are checked even then.
 */
export function decodeCursor(query: DirectoryQuery, cursor: string): CursorKey {
  const bad = () => new HttpError(400, BAD_CURSOR);
  if (cursor.length > 400) throw bad();
  const [payload, signature, extra] = cursor.split(".");
  if (!payload || !signature || extra !== undefined || !/^[0-9a-f]{32}$/.test(signature)) throw bad();
  if (!safeEqualHex(signature, cursorSignature(query, payload))) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const { v, k, i } = (parsed ?? {}) as Record<string, unknown>;
  if (v !== 1 || typeof i !== "string" || !/^[0-9a-f]{24}$/.test(i)) throw bad();
  if (query.sort === "name" ? typeof k !== "string" || k.length > 200 : !Number.isInteger(k) || (k as number) < -1 || (k as number) > 100)
    throw bad();
  return { sort: query.sort, key: k as number | string, id: i };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The MongoDB filter for a query (before the cursor). Every filter applies before paging. */
export function directoryFilter(query: DirectoryQuery): Filter<VetDirectoryDoc> {
  const filter: Filter<VetDirectoryDoc> = { listed: true };
  if (query.state) filter.state = query.state;
  if (query.specialty) filter.specialization = query.specialty;
  if (query.service) filter.serviceCategories = query.service;
  if (query.date) {
    filter.workDays = weekday(query.date);
    filter.blockedDates = { $ne: query.date };
  }
  if (query.q) filter.searchWords = { $all: query.q.split(" ").map((w) => new RegExp(`^${escapeRegex(w)}`)) };
  return filter;
}

function toCard(doc: VetDirectoryDoc, next: Date | null): VetCard {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    photoUrl: doc.photoUrl,
    specialization: doc.specialization ? specializationLabel("veterinarian", doc.specialization) || null : null,
    yearsOfExperience: doc.yearsOfExperience,
    state: doc.state,
    area: doc.area,
    serviceTypes: doc.serviceCategories.map((c) => categoryLabel("veterinarian", c)),
    priceFromNgn: doc.priceFromNgn,
    nextOpenSlot: next?.toISOString() ?? null,
  };
}

/**
 * One page of the directory, in a fixed order with the id as tie-breaker,
 * continuing after `cursor` (keyset paging: no offsets, no total count).
 * Reads at most limit + 1 entries and one batch of slot holds.
 */
export async function searchDirectory(
  query: DirectoryQuery,
  cursor: string | null,
  limit: number,
  now = new Date(),
): Promise<DirectoryPage> {
  const { directory } = await vetCollections();
  const filter = directoryFilter(query);
  if (cursor) {
    const after = decodeCursor(query, cursor);
    const id = new ObjectId(after.id);
    filter.$or =
      after.sort === "name"
        ? [{ nameKey: { $gt: after.key as string } }, { nameKey: after.key as string, _id: { $gt: id } }]
        : [{ experienceKey: { $lt: after.key as number } }, { experienceKey: after.key as number, _id: { $gt: id } }];
  }
  const sort: Sort = query.sort === "name" ? { nameKey: 1, _id: 1 } : { experienceKey: -1, _id: 1 };
  const docs = await directory.find(filter).sort(sort).limit(limit + 1).toArray();
  const page = docs.slice(0, limit);
  const { from, to } = lookahead(now);
  const held = await heldUnits(
    page.map((d) => d._id),
    from,
    to,
  );
  return {
    vets: page.map((d) => toCard(d, firstOpenSlot(d, d.minBlockMinutes, held.get(d._id.toHexString())!, now))),
    nextCursor: docs.length > limit ? encodeCursor(query, page[page.length - 1]) : null,
  };
}

// --- a vet's profile and booking source -----------------------------------------

export type BookableVet = {
  user: UserDoc;
  settings: VetAvailabilityDoc;
  services: ServiceDoc[];
};

/**
 * A vet who can be booked right now, read from the sources (not the
 * directory), or null — for an unknown id, another role, an unverified
 * credential, a hidden listing or no bookable service alike.
 */
export async function findBookableVet(id: unknown): Promise<BookableVet | null> {
  const _id = parseId(id);
  if (!_id) return null;
  const { users, availability } = await vetCollections();
  const user = await users.findOne({ _id, role: "veterinarian" }, { projection: VET_PROJECTION });
  if (!user) return null;
  const [settings, services] = await Promise.all([availability.findOne({ _id }), bookableServices(_id)]);
  if (!settings || listingIssues(user, settings, services).length > 0) return null;
  return { user: user as UserDoc, settings, services };
}

export async function getVetProfile(id: unknown, now = new Date()): Promise<VetProfile | null> {
  const vet = await findBookableVet(id);
  if (!vet) return null;
  const { user, settings, services } = vet;
  const p = user.profile ?? {};
  const { from, to } = lookahead(now);
  const held = (await heldUnits([user._id], from, to)).get(user._id.toHexString())!;
  const block = Math.min(...services.map((s) => blockMinutes(s.durationMinutes, settings.slotMinutes)));
  return {
    id: user._id.toHexString(),
    name: user.fullName,
    photoUrl: p.photo?.url ?? null,
    bio: p.bio ?? "",
    specialization: p.specialization ? specializationLabel("veterinarian", p.specialization) || null : null,
    yearsOfExperience: p.yearsOfExperience ?? null,
    state: settings.state,
    area: settings.area,
    workingHours: [...settings.hours].sort((a, b) => a.day - b.day),
    services: services.map((s) => ({
      id: s._id.toHexString(),
      name: s.name,
      categoryLabel: categoryLabel("veterinarian", s.category),
      description: s.description,
      priceNgn: s.priceNgn,
      durationMinutes: s.durationMinutes,
    })),
    nextOpenSlot: firstOpenSlot(settings, block, held, now)?.toISOString() ?? null,
  };
}
