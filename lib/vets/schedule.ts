import type { SlotMinutes, WeeklyHours } from "./types";

// Appointment times. Everything is in Lagos time (West Africa Time, UTC+1
// all year: Nigeria has no daylight saving), so a local date and minute map
// to exactly one instant. Pure functions, shared by the server (which
// decides) and the browser (which only displays).

export const LAGOS_OFFSET_MS = 60 * 60_000;
export const LAGOS_TZ = "Africa/Lagos";

/** Every booking holds whole 30-minute units, whatever the vet's slot length. */
export const UNIT_MINUTES = 30;

export const BOOKING_RULES = {
  /** the earliest a slot can start, from now */
  minNoticeMs: 2 * 60 * 60_000,
  /** how far ahead slots are offered, in days (today counts as day 0) */
  windowDays: 30,
  /** an unanswered request lapses after this, or at its start time if sooner */
  respondWithinMs: 24 * 60 * 60_000,
  /** a customer can cancel an accepted visit until this long before it starts */
  customerCancelCutoffMs: 2 * 60 * 60_000,
  /** the vet can mark a visit started from this long before its start time */
  startEarlyMs: 60 * 60_000,
  /** open requests (waiting or accepted) one customer can have at once */
  maxOpenPerCustomer: 10,
} as const;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD. */
export function isDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** The Lagos calendar date of an instant. */
export function lagosDate(at: Date): string {
  return new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes after Lagos midnight of an instant. */
export function lagosMinute(at: Date): number {
  const shifted = new Date(at.getTime() + LAGOS_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The instant of a Lagos date and minute. */
export function lagosInstant(date: string, minute: number): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + minute * 60_000 - LAGOS_OFFSET_MS);
}

/** Minutes a booking blocks: its duration (or one slot when it varies), rounded up to whole units. */
export function blockMinutes(durationMinutes: number | null, slotMinutes: SlotMinutes): number {
  const raw = durationMinutes ?? slotMinutes;
  return Math.max(1, Math.ceil(raw / UNIT_MINUTES)) * UNIT_MINUTES;
}

/** The start of each 30-minute unit a booking holds. */
export function unitStarts(startsAt: Date, block: number): Date[] {
  const out: Date[] = [];
  for (let m = 0; m < block; m += UNIT_MINUTES) out.push(new Date(startsAt.getTime() + m * 60_000));
  return out;
}

export type Schedule = { hours: WeeklyHours; slotMinutes: SlotMinutes; blockedDates: readonly string[] };

/** The last date slots are offered on, counted from today in Lagos. */
export const lastBookableDate = (now: Date) => addDays(lagosDate(now), BOOKING_RULES.windowDays);

/**
 * The open start times on one date for a booking of `block` minutes: inside
 * the vet's hours for that weekday, not on a blocked date, at least the
 * minimum notice from now, within the booking window, and with every unit
 * free (`taken` holds the epoch ms of units already held).
 */
export function openSlots(schedule: Schedule, date: string, block: number, taken: ReadonlySet<number>, now: Date): Date[] {
  if (!isDateString(date) || schedule.blockedDates.includes(date)) return [];
  if (date < lagosDate(now) || date > lastBookableDate(now)) return [];
  const day = schedule.hours.find((h) => h.day === weekday(date));
  if (!day) return [];
  const earliest = now.getTime() + BOOKING_RULES.minNoticeMs;
  const out: Date[] = [];
  for (let start = day.start; start + block <= day.end; start += schedule.slotMinutes) {
    const at = lagosInstant(date, start);
    if (at.getTime() < earliest) continue;
    if (unitStarts(at, block).some((u) => taken.has(u.getTime()))) continue;
    out.push(at);
  }
  return out;
}

/** Whether `startsAt` is one of the open slots on its date. */
export function isOpenSlot(schedule: Schedule, startsAt: Date, block: number, taken: ReadonlySet<number>, now: Date) {
  return openSlots(schedule, lagosDate(startsAt), block, taken, now).some((s) => s.getTime() === startsAt.getTime());
}

/** e.g. "08:30" for 510. */
export function minuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** "Tue 21 Oct, 9:00 am" (Lagos time). */
export function formatSlot(iso: string, withDate = true): string {
  return new Intl.DateTimeFormat("en-NG", {
    ...(withDate ? { weekday: "short", day: "numeric", month: "short" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone: LAGOS_TZ,
  }).format(new Date(iso));
}

/** A YYYY-MM-DD date: "Tue, 21 Oct", or just "Tue". */
export function formatDay(date: string, weekdayOnly = false): string {
  return new Intl.DateTimeFormat("en-NG", {
    weekday: "short",
    ...(weekdayOnly ? {} : { day: "numeric", month: "short" }),
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
