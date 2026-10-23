import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { formatDate } from "@/components/wallet/wallet-parts";
import type { CasePriority } from "@/lib/admin/cases";
import { ADMIN_ACTION_LABELS, type AuditEntry } from "@/lib/admin/types";

// Building blocks shared by the admin pages. They only render what the
// server already decided to show; none of them reads data or checks access.

/** Tabs between the views of one admin list (status filters). */
export function AdminTabs({
  label,
  current,
  tabs,
}: {
  label: string;
  current: string;
  tabs: ReadonlyArray<{ key: string; label: string; href: string }>;
}) {
  return (
    <nav
      aria-label={label}
      className="mb-4 grid gap-1 rounded-full bg-foreground/5 p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? "page" : undefined}
          className={`flex h-9 items-center justify-center rounded-full px-1 text-[0.8125rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            tab.key === current ? "bg-white text-primary shadow-sm" : "text-foreground/60 hover:text-foreground"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/** A card of label / value rows for one case. */
export function Facts({ label, rows }: { label: string; rows: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl aria-label={label} className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
      {rows.map(([term, value]) => (
        <div key={term} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-xs font-medium text-muted-foreground sm:w-40 sm:text-sm">{term}</dt>
          <dd className="min-w-0 text-sm break-words whitespace-pre-line">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "waiting" | "good" | "bad" }) {
  const tones = {
    neutral: "bg-foreground/6 text-foreground/65",
    waiting: "bg-amber-50 text-amber-800",
    good: "bg-accent/12 text-primary",
    bad: "bg-red-50 text-red-700",
  } as const;
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${tones[tone]}`}>{children}</span>
  );
}

export const PRIORITY_TONE: Record<CasePriority, "bad" | "waiting" | "neutral"> = {
  urgent: "bad",
  high: "waiting",
  normal: "neutral",
  low: "neutral",
};

/** "partially_refunded" → "Partially refunded". */
export const humanize = (value: string) => {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Audit records, newest first. Read only: there's nothing to edit here. */
export function AuditList({ entries, showTarget = false }: { entries: AuditEntry[]; showTarget?: boolean }) {
  return (
    <ul aria-label="Admin actions" className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
      {entries.map((entry) => (
        <li key={entry.id} className="px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium">{ADMIN_ACTION_LABELS[entry.action]}</p>
            <time dateTime={entry.at} className="shrink-0 text-xs text-muted-foreground">
              {formatDate(entry.at, true)}
            </time>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {entry.actorUserId ? `By ${entry.actorName ?? "a removed account"}` : "By the internal support job"}
            {entry.from && entry.to && ` · ${humanize(entry.from)} → ${humanize(entry.to)}`}
          </p>
          {showTarget && (
            <p className="mt-0.5 font-mono text-[0.6875rem] break-all text-foreground/55">
              {entry.target.type}: {entry.target.id}
            </p>
          )}
          {entry.reason && (
            <p className="mt-1.5 rounded-xl bg-foreground/[0.04] px-3 py-2 text-sm whitespace-pre-line break-words text-foreground/80">
              {entry.reason}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A link row in an admin list. */
export function CaseLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 px-4 py-3.5 outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <div className="min-w-0 flex-1">{children}</div>
        <Icon name="chevron-right" className="size-[18px] shrink-0 text-foreground/35" />
      </Link>
    </li>
  );
}

/** Reads ?page= leniently for pages: anything invalid is page 1. */
export function pageParam(value: string | undefined): number {
  return value && /^[1-9]\d{0,3}$/.test(value) ? Number(value) : 1;
}

/** Builds a pager link that keeps the other filters. */
export function pageHref(base: string, params: Record<string, string | null>, page: number): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}
