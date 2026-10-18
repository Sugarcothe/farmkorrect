import "server-only";
import type { ObjectId } from "mongodb";
import { isNigerianState } from "@/lib/locations/nigeria";
import { cleanText } from "@/lib/profile/validation";
import { addDays, blockMinutes, isDateString, lagosDate, lagosInstant, lastBookableDate, openSlots } from "@/lib/vets/schedule";
import { SLOT_OPTIONS, type AvailabilitySettings, type SlotDay, type SlotMinutes, type WeeklyHours } from "@/lib/vets/types";
import { HttpError } from "./http";
import type { ServiceDoc, UserDoc, VetAvailabilityDoc } from "./models";
import { bookableServices, heldUnits, listingIssues, refreshVetDirectory, vetCollections } from "./vet-directory";

// A veterinarian's own booking settings (the Availability tab), and the open
// slots customers can pick from. Only the signed-in vet changes their own
// settings; the vet always comes from the session.

export const AVAILABILITY_LIMITS = { area: 60, blockedDates: 60 } as const;

export const DEFAULT_SETTINGS: AvailabilitySettings = {
  listed: false,
  state: null,
  area: "",
  hours: [],
  slotMinutes: 60,
  blockedDates: [],
  sharePhoneWithClients: false,
};

export function toSettings(doc: VetAvailabilityDoc | null, now = new Date()): AvailabilitySettings {
  if (!doc) return DEFAULT_SETTINGS;
  const today = lagosDate(now);
  return {
    listed: doc.listed,
    state: doc.state,
    area: doc.area,
    hours: [...doc.hours].sort((a, b) => a.day - b.day),
    slotMinutes: doc.slotMinutes,
    // days off that have passed aren't worth showing
    blockedDates: doc.blockedDates.filter((d) => d >= today),
    sharePhoneWithClients: doc.sharePhoneWithClients,
  };
}

export function requireVet(user: Pick<UserDoc, "role">) {
  if (user.role !== "veterinarian") throw new HttpError(403, "Only veterinarian accounts can take vet appointments.");
}

const KEYS = ["listed", "state", "area", "hours", "slotMinutes", "blockedDates", "sharePhoneWithClients"];

/** Validates the whole settings object (PUT replaces them). */
export function parseAvailability(body: Record<string, unknown>, now = new Date()): AvailabilitySettings {
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(body)) if (!KEYS.includes(key)) fieldErrors[key] = "This field can't be set.";

  const { listed, state, area, hours, slotMinutes, blockedDates, sharePhoneWithClients } = body;
  if (typeof listed !== "boolean") fieldErrors.listed = "Choose whether to be listed.";
  if (typeof sharePhoneWithClients !== "boolean") fieldErrors.sharePhoneWithClients = "Choose whether to share your phone number.";
  if (state !== null && !isNigerianState(state)) fieldErrors.state = "Choose a state.";
  const cleanArea = typeof area === "string" ? cleanText(area) : null;
  if (cleanArea === null) fieldErrors.area = "Enter the area you cover.";
  else if (cleanArea.length > AVAILABILITY_LIMITS.area)
    fieldErrors.area = `Keep this to ${AVAILABILITY_LIMITS.area} characters or fewer.`;
  if (!SLOT_OPTIONS.includes(slotMinutes as SlotMinutes)) fieldErrors.slotMinutes = "Choose 30 or 60 minutes.";

  const parsedHours: WeeklyHours = [];
  if (!Array.isArray(hours) || hours.length > 7) fieldErrors.hours = "Set working hours for up to 7 days.";
  else {
    const days = new Set<number>();
    for (const h of hours as unknown[]) {
      const { day, start, end } = (h ?? {}) as Record<string, unknown>;
      const valid =
        Number.isInteger(day) &&
        (day as number) >= 0 &&
        (day as number) <= 6 &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        (start as number) % 30 === 0 &&
        (end as number) % 30 === 0 &&
        (start as number) >= 0 &&
        (end as number) <= 1440 &&
        (end as number) - (start as number) >= 30;
      if (!valid || days.has(day as number)) {
        fieldErrors.hours = "Each day needs a start before its end, on the half hour, once per day.";
        break;
      }
      days.add(day as number);
      parsedHours.push({ day: day as number, start: start as number, end: end as number });
    }
  }

  const today = lagosDate(now);
  const parsedDates: string[] = [];
  if (!Array.isArray(blockedDates) || blockedDates.length > AVAILABILITY_LIMITS.blockedDates)
    fieldErrors.blockedDates = `Add up to ${AVAILABILITY_LIMITS.blockedDates} days off.`;
  else
    for (const d of blockedDates as unknown[]) {
      if (!isDateString(d) || d < today || d > addDays(today, 366)) {
        fieldErrors.blockedDates = "Days off must be real dates from today up to a year ahead.";
        break;
      }
      if (!parsedDates.includes(d)) parsedDates.push(d);
    }

  if (listed === true && !isNigerianState(state)) fieldErrors.state ??= "Choose the state you work in to be listed.";
  if (listed === true && parsedHours.length === 0 && !fieldErrors.hours)
    fieldErrors.hours = "Set working hours for at least one day to be listed.";

  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Please check the highlighted fields.", fieldErrors);
  return {
    listed: listed as boolean,
    state: (state as AvailabilitySettings["state"]) ?? null,
    area: cleanArea!,
    hours: parsedHours.sort((a, b) => a.day - b.day),
    slotMinutes: slotMinutes as SlotMinutes,
    blockedDates: parsedDates.sort(),
    sharePhoneWithClients: sharePhoneWithClients as boolean,
  };
}

export async function getAvailability(vetUserId: ObjectId): Promise<VetAvailabilityDoc | null> {
  return (await vetCollections()).availability.findOne({ _id: vetUserId });
}

/**
 * Saves the vet's settings and rebuilds their directory entry. Existing
 * appointments are kept as booked: changing hours never moves or cancels them.
 */
export async function saveAvailability(vet: UserDoc, settings: AvailabilitySettings, now = new Date()) {
  const { availability } = await vetCollections();
  await availability.updateOne(
    { _id: vet._id },
    {
      $set: { ...settings, updatedAt: now },
      $setOnInsert: { createdAt: now, directoryRefreshedAt: null },
    },
    { upsert: true },
  );
  try {
    await refreshVetDirectory(vet._id, now);
  } catch (error) {
    // the settings are saved; the job rebuilds the entry
    console.error(`[vets] directory refresh failed; the job will retry: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

export async function availabilityResponse(vet: UserDoc, now = new Date()) {
  const [doc, services] = await Promise.all([getAvailability(vet._id), bookableServices(vet._id)]);
  return { settings: toSettings(doc, now), listingIssues: listingIssues(vet, doc, services) };
}

/** Days of slots returned per request. */
export const SLOT_DAYS = 7;

/**
 * Open slots for one service over SLOT_DAYS days from `from` (a Lagos
 * date), using the vet's current hours and the holds already taken.
 */
export function slotDays(
  settings: VetAvailabilityDoc,
  service: Pick<ServiceDoc, "durationMinutes">,
  from: string,
  held: ReadonlySet<number>,
  now: Date,
): SlotDay[] {
  const block = blockMinutes(service.durationMinutes, settings.slotMinutes);
  const days: SlotDay[] = [];
  for (let i = 0; i < SLOT_DAYS; i++) {
    const date = addDays(from, i);
    if (date > lastBookableDate(now)) break;
    days.push({ date, slots: openSlots(settings, date, block, held, now).map((d) => d.toISOString()) });
  }
  return days;
}

export async function heldFor(vetUserId: ObjectId, from: string, days: number) {
  const start = lagosInstant(from, 0);
  const end = lagosInstant(addDays(from, days + 1), 0);
  return (await heldUnits([vetUserId], start, end)).get(vetUserId.toHexString())!;
}
