import type { ReactNode } from "react";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { buttonClasses } from "@/components/ui/button";
import { formatDate } from "@/components/wallet/wallet-parts";
import {
  changeOf,
  PERIOD_LABELS,
  PERIOD_PRESETS,
  rangeQuery,
  type PeriodPreset,
  type ReportRange,
} from "@/lib/analytics/range";
import type { TrendPoint } from "@/lib/analytics/types";
import { formatKobo } from "@/lib/wallet/money";

// Building blocks for the seller's Insights and the admin Analytics screens.
// Server components only: the period picker is a plain GET form, the chart
// is drawn with CSS, and every chart has the same figures as text for
// screen readers. Changes are shown as neutral text: nothing is coloured
// good or bad, because whether a change is good depends on the metric.

export const count = (n: number) => n.toLocaleString("en-NG");

/** "1–30 Oct 2026" style label for a range (Lagos dates). */
export function rangeLabel(range: Pick<ReportRange, "from" | "to">): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${d}T00:00:00Z`),
    );
  return range.from === range.to ? fmt(range.from) : `${fmt(range.from)} – ${fmt(range.to)}`;
}

export function PeriodPicker({
  basePath,
  period,
  from,
  to,
  error,
}: {
  basePath: string;
  period: PeriodPreset | null;
  from: string;
  to: string;
  error: string | null;
}) {
  return (
    <section aria-label="Report period" className="space-y-3">
      <nav aria-label="Period" className="flex flex-wrap gap-1.5">
        {PERIOD_PRESETS.filter((p) => p !== "custom").map((p) => (
          <Link
            key={p}
            href={`${basePath}?period=${p}`}
            aria-current={p === period ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-[0.8125rem] font-medium ring-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              p === period ? "bg-primary text-white ring-primary" : "bg-white text-foreground/70 ring-foreground/10 hover:text-foreground"
            }`}
          >
            {PERIOD_LABELS[p]}
          </Link>
        ))}
      </nav>
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="period" value="custom" />
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          From
          <input
            type="date"
            name="from"
            defaultValue={from}
            required
            className="h-10 rounded-xl bg-white px-3 text-sm text-foreground ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          To
          <input
            type="date"
            name="to"
            defaultValue={to}
            required
            className="h-10 rounded-xl bg-white px-3 text-sm text-foreground ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <button type="submit" className={buttonClasses(period === "custom" ? "solid" : "outline", "h-10 w-auto px-4 text-sm")}>
          Show range
        </button>
      </form>
      {error && <FormAlert>{error}</FormAlert>}
    </section>
  );
}

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
      {note && <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>}
    </section>
  );
}

type Format = "kobo" | "count";
const show = (value: number, format: Format) => (format === "kobo" ? formatKobo(value) : count(value));

/** "+₦1,200 (+12.5%) vs previous period", or why there's no comparison. */
export function ChangeNote({ current, previous, format }: { current: number; previous: number | null; format: Format }) {
  if (previous === null) return null;
  const { difference, percent } = changeOf(current, previous);
  if (difference === null) return null;
  const sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
  const amount = show(Math.abs(difference), format);
  const pct = percent === null ? "" : ` (${percent > 0 ? "+" : percent < 0 ? "−" : ""}${Math.abs(percent)}%)`;
  return (
    <span className="block text-[0.6875rem] text-muted-foreground">
      {difference === 0 ? "Same as" : `${sign}${amount}${pct} vs`} previous period ({show(previous, format)})
    </span>
  );
}

export function Stat({
  label,
  value,
  format,
  previous,
  hint,
}: {
  label: string;
  value: number;
  format: Format;
  /** undefined: no comparison for this figure; null: no earlier history */
  previous?: number | null;
  hint?: string;
}) {
  return (
    <div className="flex flex-col rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-foreground/5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{show(value, format)}</dd>
      {previous !== undefined && (
        <dd>
          <ChangeNote current={value} previous={previous} format={format} />
        </dd>
      )}
      {hint && <dd className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">{hint}</dd>}
    </div>
  );
}

export function StatGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-3">
      {children}
    </dl>
  );
}

const bucketLabel = (p: Pick<TrendPoint, "from" | "to">) =>
  p.from === p.to ? formatDate(`${p.from}T12:00:00Z`) : `${formatDate(`${p.from}T12:00:00Z`)} – ${formatDate(`${p.to}T12:00:00Z`)}`;

/**
 * Bars for one figure of the trend, with a text summary and the full series
 * as a table for screen readers. Bars are proportional to the highest bucket.
 */
export function TrendChart<T extends TrendPoint>({
  points,
  value,
  format,
  title,
  granularity,
}: {
  points: T[];
  value: (p: T) => number;
  format: Format;
  title: string;
  granularity: "day" | "week";
}) {
  const values = points.map(value);
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...values);
  const peak = max > 0 ? points[values.indexOf(max)] : null;
  const unit = granularity === "day" ? "day" : "week";
  const summary =
    total === 0
      ? `${title}: nothing in this period.`
      : `${title}: ${show(total, format)} in total over ${points.length} ${unit}${points.length === 1 ? "" : "s"}. Highest ${unit}: ${bucketLabel(peak!)} with ${show(max, format)}.`;

  return (
    <figure className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>
      {total > 0 && (
        <div aria-hidden="true" className="mt-3 flex h-28 items-end gap-px">
          {points.map((p, i) => (
            <div
              key={p.from}
              title={`${bucketLabel(p)}: ${show(values[i], format)}`}
              className="min-w-0 flex-1 rounded-t-sm bg-primary/75"
              style={{ height: `${max > 0 ? Math.max((values[i] / max) * 100, values[i] > 0 ? 2 : 0) : 0}%` }}
            />
          ))}
        </div>
      )}
      {total > 0 && (
        <div aria-hidden="true" className="mt-1 flex justify-between text-[0.6875rem] text-muted-foreground">
          <span>{bucketLabel(points[0])}</span>
          <span>{bucketLabel(points[points.length - 1])}</span>
        </div>
      )}
      <table className="sr-only">
        <caption>{title}, by {unit}</caption>
        <thead>
          <tr>
            <th scope="col">{granularity === "day" ? "Day" : "Week"}</th>
            <th scope="col">{title}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={p.from}>
              <th scope="row">{bucketLabel(p)}</th>
              <td>{show(values[i], format)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** A compact table; numbers right-aligned. Scrolls inside itself on narrow screens. */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: ReadonlyArray<{ label: string; numeric?: boolean }>;
  rows: ReadonlyArray<{ key: string; cells: ReactNode[] }>;
}) {
  return (
    <div className="overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {columns.map((c) => (
              <th key={c.label} scope="col" className={`px-3 py-2.5 font-medium ${c.numeric ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-foreground/6">
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <td
                  key={columns[i].label}
                  className={`px-3 py-2.5 ${columns[i].numeric ? "text-right tabular-nums whitespace-nowrap" : "break-words"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Download links for the CSV exports of the shown period. */
export function Downloads({
  endpoint,
  range,
  reports,
}: {
  endpoint: string;
  range: ReportRange;
  reports: ReadonlyArray<{ report: string; label: string }>;
}) {
  const q = rangeQuery(range);
  return (
    <div className="flex flex-col gap-2">
      {reports.map((r) => (
        <a key={r.report} href={`${endpoint}?report=${r.report}&${q}`} download className={buttonClasses("outline", "text-sm")}>
          Download {r.label} (CSV)
        </a>
      ))}
    </div>
  );
}
