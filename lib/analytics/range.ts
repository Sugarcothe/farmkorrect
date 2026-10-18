// Report periods in Africa/Lagos days, shared by the server (which decides
// what a period is) and the period picker. Lagos is WAT, UTC+01:00 all year
// with no daylight saving, so a Lagos day d starts at 00:00 UTC of d minus
// one hour. "Today" comes from Intl with an explicit timeZone, never from the
// server's own zone. Every range is half-open: [start, end).

export const REPORT_TIME_ZONE = "Africa/Lagos";
const LAGOS_OFFSET_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Longest custom range, in days (inclusive of both ends). */
export const MAX_RANGE_DAYS = 366;
/** No report reaches back before this Lagos date. */
export const EARLIEST_DATE = "2024-01-01";
/** Ranges longer than this are shown week by week. */
export const DAILY_MAX_DAYS = 62;

export const PERIOD_PRESETS = ["last7", "last30", "this_month", "last_month", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  last7: "Last 7 days",
  last30: "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom range",
};

export const DEFAULT_PERIOD: PeriodPreset = "last30";

/** A run of whole Lagos days. from/to are inclusive dates; start/end the half-open instants. */
export type Span = { from: string; to: string; days: number; start: string; end: string };

export type ReportRange = Span & {
  period: PeriodPreset;
  granularity: "day" | "week";
  /** the period it's compared with */
  previous: Span;
};

export type RangeInput = { period?: string | null; from?: string | null; to?: string | null };

export type RangeResult = { ok: true; range: ReportRange } | { ok: false; field: "period" | "from" | "to"; message: string };

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 for a real calendar date, or null. */
export function dayIndex(date: string): number | null {
  const m = YMD.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

export const dateOf = (index: number) => new Date(index * DAY_MS).toISOString().slice(0, 10);

/** The instant a Lagos day starts. */
export const lagosDayStart = (index: number) => new Date(index * DAY_MS - LAGOS_OFFSET_MS);

/** Today's Lagos date as a day index. */
export function lagosToday(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return dayIndex(`${get("year")}-${get("month")}-${get("day")}`)!;
}

function span(fromIndex: number, toIndex: number): Span {
  return {
    from: dateOf(fromIndex),
    to: dateOf(toIndex),
    days: toIndex - fromIndex + 1,
    start: lagosDayStart(fromIndex).toISOString(),
    end: lagosDayStart(toIndex + 1).toISOString(),
  };
}

/** First day of the month `offset` months from the month containing `index`. */
function monthStart(index: number, offset = 0): number {
  const d = new Date(index * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1) / DAY_MS;
}

function withPrevious(period: PeriodPreset, from: number, to: number, previous: [number, number]): ReportRange {
  const days = to - from + 1;
  return { ...span(from, to), period, granularity: days > DAILY_MAX_DAYS ? "week" : "day", previous: span(...previous) };
}

const isPreset = (value: string): value is PeriodPreset => (PERIOD_PRESETS as readonly string[]).includes(value);

/**
 * The period a request asks for. Presets are relative to today in Lagos;
 * a custom range must be real dates, in order, no later than today, no
 * earlier than EARLIEST_DATE and at most MAX_RANGE_DAYS long.
 */
export function resolveRange(input: RangeInput, now = new Date()): RangeResult {
  const period = input.period || DEFAULT_PERIOD;
  if (!isPreset(period)) return { ok: false, field: "period", message: "Choose a period from the list." };
  const today = lagosToday(now);

  if (period === "last7" || period === "last30") {
    const n = period === "last7" ? 7 : 30;
    const from = today - (n - 1);
    return { ok: true, range: withPrevious(period, from, today, [from - n, from - 1]) };
  }
  if (period === "this_month") {
    const from = monthStart(today);
    const prevFrom = monthStart(today, -1);
    const prevTo = Math.min(prevFrom + (today - from), from - 1);
    return { ok: true, range: withPrevious(period, from, today, [prevFrom, prevTo]) };
  }
  if (period === "last_month") {
    const from = monthStart(today, -1);
    const to = monthStart(today) - 1;
    return { ok: true, range: withPrevious(period, from, to, [monthStart(today, -2), from - 1]) };
  }

  const from = dayIndex(input.from ?? "");
  if (from === null) return { ok: false, field: "from", message: "Enter a valid start date." };
  const to = dayIndex(input.to ?? "");
  if (to === null) return { ok: false, field: "to", message: "Enter a valid end date." };
  if (from < dayIndex(EARLIEST_DATE)!)
    return { ok: false, field: "from", message: `Reports start from ${EARLIEST_DATE}.` };
  if (to > today) return { ok: false, field: "to", message: "The end date can't be in the future." };
  if (from > to) return { ok: false, field: "from", message: "The start date must be on or before the end date." };
  const days = to - from + 1;
  if (days > MAX_RANGE_DAYS)
    return { ok: false, field: "to", message: `Choose a range of at most ${MAX_RANGE_DAYS} days.` };
  return { ok: true, range: withPrevious("custom", from, to, [from - days, from - 1]) };
}

/** The trend's buckets: each day, or 7-day runs from the first day (the last may be shorter). */
export function bucketsOf(range: Pick<ReportRange, "from" | "to" | "granularity">): Array<{ from: string; to: string }> {
  const first = dayIndex(range.from)!;
  const last = dayIndex(range.to)!;
  const step = range.granularity === "week" ? 7 : 1;
  const buckets: Array<{ from: string; to: string }> = [];
  for (let d = first; d <= last; d += step) buckets.push({ from: dateOf(d), to: dateOf(Math.min(d + step - 1, last)) });
  return buckets;
}

/** The query string for a range (what links and the CSV download use). */
export function rangeQuery(range: Pick<ReportRange, "period" | "from" | "to">): string {
  const params = new URLSearchParams({ period: range.period });
  if (range.period === "custom") {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  return params.toString();
}

/** Change between two period figures; percent only when there's something to compare with. */
export function changeOf(current: number, previous: number | null): { difference: number | null; percent: number | null } {
  if (previous === null) return { difference: null, percent: null };
  const difference = current - previous;
  return { difference, percent: previous > 0 ? Math.round((difference / previous) * 1000) / 10 : null };
}
