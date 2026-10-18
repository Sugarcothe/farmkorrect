"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { EmptyList } from "@/components/wallet/wallet-parts";
import { NIGERIAN_STATES, stateLabel } from "@/lib/locations/nigeria";
import { SPECIALIZATIONS, specializationLabel } from "@/lib/profile/config";
import { categoryLabel, SERVICE_CATEGORIES } from "@/lib/services/config";
import { searchVets } from "@/lib/vets/api";
import { cleanVetSearch, DEFAULT_QUERY, hasFilters, queryParams } from "@/lib/vets/query";
import { formatDay, lastBookableDate, lagosDate } from "@/lib/vets/schedule";
import {
  DIRECTORY_SORTS,
  type DirectoryPage,
  type DirectoryQuery,
  type DirectorySort,
  type VetCard,
} from "@/lib/vets/types";
import { VetCardView } from "./vet-parts";

const DEBOUNCE_MS = 400;

type Status = "ready" | "loading" | "error";

/** Adds a page, skipping any vet already shown (data can shift between pages). */
function merge(current: VetCard[], next: VetCard[]) {
  const seen = new Set(current.map((v) => v.id));
  return [...current, ...next.filter((v) => !seen.has(v.id))];
}

/**
 * The Find a Vet list. Filters live in the address (replaced, not pushed,
 * so Back leaves the directory) and are re-read by the server when the
 * page is opened again, e.g. coming Back from a vet's profile. Every search
 * runs on the server, a page at a time: a newer search cancels the one
 * before it, and a reply that arrives late is ignored.
 */
export function VetDirectory({
  initialQuery,
  initialPage,
}: {
  initialQuery: DirectoryQuery;
  initialPage: DirectoryPage | null;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [text, setText] = useState(initialQuery.q);
  const [vets, setVets] = useState<VetCard[]>(initialPage?.vets ?? []);
  const [cursor, setCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  const [status, setStatus] = useState<Status>(initialPage ? "ready" : "error");
  const [moreStatus, setMoreStatus] = useState<Status>("ready");
  const [moreError, setMoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const today = lagosDate(new Date());

  async function load(next: DirectoryQuery, after: string | null) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const id = ++seq.current;
    if (after) {
      setMoreStatus("loading");
      setMoreError(null);
    } else {
      setStatus("loading");
      setError(null);
    }
    const res = await searchVets(next, after, abort.signal);
    if (id !== seq.current) return; // a newer search started; this reply is stale
    controller.current = null;
    if (!res.ok) {
      if (after) {
        setMoreStatus("error");
        setMoreError(res.error);
      } else {
        setStatus("error");
        setError(res.error);
      }
      return;
    }
    setVets((current) => (after ? merge(current, res.data.vets) : merge([], res.data.vets)));
    setCursor(res.data.nextCursor);
    if (after) setMoreStatus("ready");
    else setStatus("ready");
  }

  /** A new search: back to its first page, with the address kept in step. */
  function apply(changes: Partial<DirectoryQuery>) {
    const next = { ...query, ...changes };
    setQuery(next);
    setCursor(null);
    setMoreStatus("ready");
    setMoreError(null);
    const search = queryParams(next).toString();
    window.history.replaceState(null, "", search ? `/vets?${search}` : "/vets");
    void load(next, null);
  }

  // typing settles before searching
  useEffect(() => {
    const q = cleanVetSearch(text);
    if (q === query.q) return;
    const timer = setTimeout(() => apply({ q }), DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on typing only
  }, [text]);

  useEffect(() => () => controller.current?.abort(), []);

  const chips: { key: string; label: string; clear: Partial<DirectoryQuery> }[] = [
    ...(query.q ? [{ key: "q", label: `“${query.q}”`, clear: { q: "" } }] : []),
    ...(query.state ? [{ key: "state", label: stateLabel(query.state), clear: { state: null } }] : []),
    ...(query.specialty
      ? [{ key: "specialty", label: specializationLabel("veterinarian", query.specialty), clear: { specialty: null } }]
      : []),
    ...(query.service
      ? [{ key: "service", label: categoryLabel("veterinarian", query.service), clear: { service: null } }]
      : []),
    ...(query.date ? [{ key: "date", label: `Works on ${formatDay(query.date)}`, clear: { date: null } }] : []),
  ];

  function clearAll() {
    setText("");
    apply({ ...DEFAULT_QUERY, sort: query.sort });
  }

  const selectClass =
    "h-11 w-full cursor-pointer appearance-none rounded-xl border border-foreground/12 bg-white px-3.5 pr-9 text-sm outline-none focus:border-accent focus:ring-3 focus:ring-accent/15";

  return (
    <div className="flex flex-col gap-3">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = cleanVetSearch(text);
          if (q !== query.q) apply({ q });
        }}
        className="relative"
      >
        <label htmlFor="vet-search" className="sr-only">
          Search vets
        </label>
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-foreground/45"
        />
        <input
          id="vet-search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          maxLength={120}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by name, specialty, service or area"
          className="h-12 w-full rounded-full bg-white pr-12 pl-11 text-[0.9375rem] shadow-sm ring-1 ring-foreground/8 outline-none placeholder:text-[0.8125rem] placeholder:text-foreground/40 focus:ring-2 focus:ring-accent [&::-webkit-search-cancel-button]:hidden"
        />
        {text && (
          <button
            type="button"
            onClick={() => {
              setText("");
              apply({ q: "" });
            }}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-foreground/55 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="x" className="size-4" />
          </button>
        )}
      </form>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
          aria-controls="vet-filters"
          className="flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-medium text-primary ring-1 ring-foreground/8 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Icon name="sliders" className="size-4" />
          Filters
          {chips.filter((c) => c.key !== "q").length > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] font-semibold text-primary-foreground">
              {chips.filter((c) => c.key !== "q").length}
              <span className="sr-only"> in use</span>
            </span>
          )}
        </button>
        <label className="relative ml-auto flex h-10 items-center rounded-full bg-white ring-1 ring-foreground/8 focus-within:ring-2 focus-within:ring-accent">
          <span className="sr-only">Sort by</span>
          <select
            value={query.sort}
            onChange={(e) => apply({ sort: e.target.value as DirectorySort })}
            className="h-full cursor-pointer appearance-none rounded-full bg-transparent pr-9 pl-4 text-sm font-medium outline-none"
          >
            {DIRECTORY_SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" className="pointer-events-none absolute right-3 size-4 text-foreground/50" />
        </label>
      </div>

      <div
        role="group"
        aria-label="Quick filters"
        className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none]"
      >
        {quickFilters(today).map((f) => {
          const on = f.isOn(query);
          return (
            <button
              key={f.label}
              type="button"
              aria-pressed={on}
              onClick={() => apply(on ? f.off : f.on)}
              className={`flex h-8 shrink-0 items-center rounded-full px-3.5 text-xs font-medium ring-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? "bg-primary text-primary-foreground ring-primary" : "bg-white text-foreground/75 ring-foreground/10 hover:bg-primary/5"}`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {filtersOpen && (
        <div
          id="vet-filters"
          className="grid grid-cols-1 gap-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5 sm:grid-cols-2"
        >
          <FilterSelect
            label="State"
            hint="Where the vet works. Set this to your farm's state to find vets near you."
            value={query.state ?? ""}
            onChange={(v) => apply({ state: (v || null) as DirectoryQuery["state"] })}
            options={[{ value: "", label: "All of Nigeria" }, ...NIGERIAN_STATES]}
            className={selectClass}
          />
          <FilterSelect
            label="Specialty"
            value={query.specialty ?? ""}
            onChange={(v) => apply({ specialty: v || null })}
            options={[{ value: "", label: "Any specialty" }, ...SPECIALIZATIONS.veterinarian]}
            className={selectClass}
          />
          <FilterSelect
            label="Service"
            value={query.service ?? ""}
            onChange={(v) => apply({ service: v || null })}
            options={[{ value: "", label: "Any service" }, ...SERVICE_CATEGORIES.veterinarian]}
            className={selectClass}
          />
          <div>
            <label htmlFor="vet-date" className="mb-1.5 block text-[0.8125rem] font-semibold">
              Works on
            </label>
            <input
              id="vet-date"
              type="date"
              min={today}
              max={lastBookableDate(new Date())}
              value={query.date ?? ""}
              onChange={(e) => apply({ date: e.target.value || null })}
              aria-describedby="vet-date-hint"
              className="h-11 w-full rounded-xl border border-foreground/12 bg-white px-3.5 text-sm outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
            />
            <p id="vet-date-hint" className="mt-1.5 text-xs text-muted-foreground">
              Vets whose working days include this date. Open times are shown on their profile.
            </p>
          </div>
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="sr-only">Active filters:</span>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                if (c.key === "q") setText("");
                apply(c.clear);
              }}
              aria-label={`Remove filter: ${c.label}`}
              className="flex h-8 max-w-full items-center gap-1 rounded-full bg-primary/8 pr-2 pl-3 text-xs font-medium text-primary outline-none hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="truncate">{c.label}</span>
              <Icon name="x" className="size-3.5 shrink-0" />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="flex h-8 items-center rounded-full px-2.5 text-xs font-medium text-foreground/60 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          >
            Clear all
          </button>
        </div>
      )}

      <div aria-live="polite" className="sr-only">
        {status === "loading"
          ? "Searching…"
          : status === "ready"
            ? `${vets.length} vets shown${cursor ? ", more available" : ""}`
            : ""}
      </div>

      {status === "loading" ? (
        <CardSkeletons />
      ) : status === "error" ? (
        <div
          role="alert"
          className="flex flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-foreground/5"
        >
          <div className="flex size-14 items-center justify-center rounded-2xl bg-red-50 text-red-700">
            <Icon name="alert-circle" className="size-7" />
          </div>
          <h3 className="mt-4 text-base font-semibold">Couldn&rsquo;t load vets</h3>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
            {error ?? "Something went wrong on our side."} Your search and filters are kept.
          </p>
          <Button type="button" className="mt-4 h-10 w-auto px-5 text-sm" onClick={() => void load(query, null)}>
            Try again
          </Button>
        </div>
      ) : vets.length === 0 ? (
        hasFilters(query) ? (
          <EmptyList icon="search" title="No vets match your search">
            Try fewer words or filters.{" "}
            <button
              type="button"
              onClick={clearAll}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              Clear search and filters
            </button>
          </EmptyList>
        ) : (
          <EmptyList icon="stethoscope" title="No vets listed yet">
            Veterinarians appear here once the Farm Korret team has reviewed their credentials and they&rsquo;ve set up
            their services and working hours.
          </EmptyList>
        )
      ) : (
        <>
          <ul aria-label="Vets" className="flex flex-col gap-3">
            {vets.map((v) => (
              <li key={v.id}>
                <VetCardView vet={v} href={`/vets/${v.id}`} />
              </li>
            ))}
          </ul>
          {moreError && (
            <p role="alert" className="text-center text-sm text-red-700">
              {moreError}
            </p>
          )}
          {cursor ? (
            <Button
              type="button"
              variant="outline"
              loading={moreStatus === "loading"}
              onClick={() => void load(query, cursor)}
            >
              {moreStatus === "loading"
                ? "Loading…"
                : moreStatus === "error"
                  ? "Try loading more again"
                  : "Load more vets"}
            </Button>
          ) : (
            <p className="py-2 text-center text-xs text-muted-foreground">
              That&rsquo;s everyone matching your search.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One-tap versions of the filters. Each sets a real filter (shown as a chip
 * below and in the address); there's no distance or rating filter because
 * there are no farm coordinates or vet reviews to filter on.
 */
function quickFilters(today: string): {
  label: string;
  isOn: (q: DirectoryQuery) => boolean;
  on: Partial<DirectoryQuery>;
  off: Partial<DirectoryQuery>;
}[] {
  return [
    {
      label: "Works today",
      isOn: (q) => q.date === today,
      on: { date: today },
      off: { date: null },
    },
    {
      label: "Poultry medicine",
      isOn: (q) => q.specialty === "poultry-medicine",
      on: { specialty: "poultry-medicine" },
      off: { specialty: null },
    },
    {
      label: "Vaccination",
      isOn: (q) => q.service === "vaccination",
      on: { service: "vaccination" },
      off: { service: null },
    },
    {
      label: "Emergency visits",
      isOn: (q) => q.service === "emergency-visit",
      on: { service: "emergency-visit" },
      off: { service: null },
    },
  ];
}

function FilterSelect({
  label,
  hint,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  className: string;
}) {
  const id = `vet-filter-${label.toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[0.8125rem] font-semibold">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={className}
        >
          {options.map((o) => (
            <option key={o.value || "any"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon
          name="chevron-down"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-foreground/50"
        />
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function CardSkeletons() {
  return (
    <ul aria-busy="true" aria-label="Loading vets" className="flex flex-col gap-3">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="flex animate-pulse gap-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
          <div className="size-14 shrink-0 rounded-full bg-foreground/8" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-4 w-40 rounded-full bg-foreground/8" />
            <div className="h-3 w-28 rounded-full bg-foreground/6" />
            <div className="h-3 w-2/3 rounded-full bg-foreground/6" />
          </div>
        </li>
      ))}
    </ul>
  );
}
