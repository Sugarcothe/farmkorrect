"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { EmptyList } from "@/components/wallet/wallet-parts";
import { NIGERIAN_STATES, stateLabel } from "@/lib/locations/nigeria";
import { searchServices } from "@/lib/services/api";
import { MARKETPLACE_CATEGORIES, SERVICE_LIMITS, SERVICE_PRICING, type ServicePricing } from "@/lib/services/config";
import {
  DEFAULT_SERVICE_QUERY,
  hasServiceFilters,
  marketplaceCategoryInfo,
  serviceQueryParams,
  type ServiceCard,
  type ServiceDirectoryPage,
  type ServiceDirectoryQuery,
} from "@/lib/services/marketplace";
import { cleanVetSearch } from "@/lib/vets/query";
import { formatKobo } from "@/lib/wallet/money";
import { CardSkeletons, ServiceCardView } from "./service-parts";

const DEBOUNCE_MS = 400;
const PATH = "/services";

type Status = "ready" | "loading" | "error";

/** Adds a page, skipping any service already shown (data can shift between pages). */
function merge(current: ServiceCard[], next: ServiceCard[]) {
  const seen = new Set(current.map((s) => s.id));
  return [...current, ...next.filter((s) => !seen.has(s.id))];
}

/**
 * The Other Services directory. Filters live in the address (replaced, not
 * pushed) and are re-read by the server when the page is opened again, e.g.
 * coming Back from a service. Every search runs on the server a page at a
 * time; a newer search cancels the one before it and a late reply is ignored.
 */
export function ServiceDirectory({
  initialQuery,
  initialPage,
}: {
  initialQuery: ServiceDirectoryQuery;
  initialPage: ServiceDirectoryPage | null;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [text, setText] = useState(initialQuery.q);
  const [maxPriceText, setMaxPriceText] = useState(initialQuery.maxPrice !== null ? String(initialQuery.maxPrice) : "");
  const [services, setServices] = useState<ServiceCard[]>(initialPage?.services ?? []);
  const [cursor, setCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  const [status, setStatus] = useState<Status>(initialPage ? "ready" : "error");
  const [moreStatus, setMoreStatus] = useState<Status>("ready");
  const [moreError, setMoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);

  async function load(next: ServiceDirectoryQuery, after: string | null) {
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
    const res = await searchServices(next, after, abort.signal);
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
    setServices((current) => (after ? merge(current, res.data.services) : merge([], res.data.services)));
    setCursor(res.data.nextCursor);
    if (after) setMoreStatus("ready");
    else setStatus("ready");
  }

  /** A new search: back to its first page, with the address kept in step. */
  function apply(changes: Partial<ServiceDirectoryQuery>) {
    const next = { ...query, ...changes };
    // a price limit only applies to fixed prices
    if (next.maxPrice !== null) next.pricing = "fixed";
    if (next.pricing !== "fixed") next.maxPrice = null;
    setQuery(next);
    setMaxPriceText(next.maxPrice !== null ? String(next.maxPrice) : "");
    setCursor(null);
    setMoreStatus("ready");
    setMoreError(null);
    const search = serviceQueryParams(next).toString();
    window.history.replaceState(null, "", search ? `${PATH}?${search}` : PATH);
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

  function applyMaxPrice() {
    const raw = maxPriceText.replace(/[\s,₦]/g, "");
    if (!raw) {
      if (query.maxPrice !== null) apply({ maxPrice: null });
      return;
    }
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < 1 || n > SERVICE_LIMITS.maxPriceNgn) {
      setMaxPriceText(query.maxPrice !== null ? String(query.maxPrice) : "");
      return;
    }
    if (n !== query.maxPrice) apply({ maxPrice: n });
  }

  const chips: { key: string; label: string; clear: Partial<ServiceDirectoryQuery> }[] = [
    ...(query.q ? [{ key: "q", label: `“${query.q}”`, clear: { q: "" } }] : []),
    ...(query.category
      ? [{ key: "category", label: marketplaceCategoryInfo(query.category)?.label ?? "", clear: { category: null } }]
      : []),
    ...(query.state ? [{ key: "state", label: stateLabel(query.state), clear: { state: null } }] : []),
    ...(query.pricing
      ? [
          {
            key: "pricing",
            label: SERVICE_PRICING.find((p) => p.value === query.pricing)!.label,
            clear: { pricing: null, maxPrice: null },
          },
        ]
      : []),
    ...(query.maxPrice !== null
      ? [{ key: "maxPrice", label: `Up to ${formatKobo(query.maxPrice * 100)}`, clear: { maxPrice: null } }]
      : []),
  ];

  function clearAll() {
    setText("");
    apply({ ...DEFAULT_SERVICE_QUERY });
  }

  const selectClass =
    "h-11 w-full cursor-pointer appearance-none rounded-xl border border-foreground/12 bg-white px-3.5 pr-9 text-sm outline-none focus:border-accent focus:ring-3 focus:ring-accent/15";
  const filterCount = chips.filter((c) => c.key !== "q" && c.key !== "category").length;

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
        <label htmlFor="service-search" className="sr-only">
          Search services
        </label>
        <Icon
          name="search"
          className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-foreground/45"
        />
        <input
          id="service-search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          maxLength={120}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search services or providers"
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

      <section aria-labelledby="service-categories">
        <h2 id="service-categories" className="mb-2 text-sm font-semibold">
          Categories
        </h2>
        <div role="group" aria-label="Categories" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MARKETPLACE_CATEGORIES.map((c) => {
            const on = query.category === c.value;
            return (
              <button
                key={c.value}
                type="button"
                aria-pressed={on}
                onClick={() => apply({ category: on ? null : c.value })}
                className={`flex min-h-16 flex-col items-start rounded-2xl px-3 py-2.5 text-left ring-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? "bg-primary text-primary-foreground ring-primary" : "bg-white text-foreground ring-foreground/8 hover:bg-primary/5"}`}
              >
                <span className="text-[0.8125rem] font-semibold">{c.label}</span>
                <span
                  className={`mt-0.5 line-clamp-2 text-[0.6875rem] leading-snug ${on ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                >
                  {c.description}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
          aria-controls="service-filters"
          className="flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-medium text-primary ring-1 ring-foreground/8 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Icon name="sliders" className="size-4" />
          Filters
          {filterCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] font-semibold text-primary-foreground">
              {filterCount}
              <span className="sr-only"> in use</span>
            </span>
          )}
        </button>
        <p className="ml-auto text-xs text-muted-foreground">Newest first</p>
      </div>

      {filtersOpen && (
        <div
          id="service-filters"
          className="grid grid-cols-1 gap-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5 sm:grid-cols-2"
        >
          <FilterSelect
            id="service-filter-state"
            label="State"
            hint="Services whose provider covers this state."
            value={query.state ?? ""}
            onChange={(v) => apply({ state: (v || null) as ServiceDirectoryQuery["state"] })}
            options={[{ value: "", label: "All of Nigeria" }, ...NIGERIAN_STATES]}
            className={selectClass}
          />
          <FilterSelect
            id="service-filter-pricing"
            label="Pricing"
            value={query.pricing ?? ""}
            onChange={(v) => apply({ pricing: (v || null) as ServicePricing | null })}
            options={[{ value: "", label: "Any pricing" }, ...SERVICE_PRICING]}
            className={selectClass}
          />
          {query.pricing !== "quote" && (
            <div>
              <label htmlFor="service-filter-max" className="mb-1.5 block text-[0.8125rem] font-semibold">
                Maximum price (₦)
              </label>
              <input
                id="service-filter-max"
                inputMode="numeric"
                autoComplete="off"
                value={maxPriceText}
                onChange={(e) => setMaxPriceText(e.target.value)}
                onBlur={applyMaxPrice}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyMaxPrice();
                  }
                }}
                placeholder="e.g. 50,000"
                aria-describedby="service-filter-max-hint"
                className="h-11 w-full rounded-xl border border-foreground/12 bg-white px-3.5 text-sm outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
              />
              <p id="service-filter-max-hint" className="mt-1.5 text-xs text-muted-foreground">
                Fixed-price services only. Quote-on-request services are left out.
              </p>
            </div>
          )}
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
            ? `${services.length} services shown${cursor ? ", more available" : ""}`
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
          <h3 className="mt-4 text-base font-semibold">Couldn&rsquo;t load services</h3>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
            {error ?? "Something went wrong on our side."} Your search and filters are kept.
          </p>
          <Button type="button" className="mt-4 h-10 w-auto px-5 text-sm" onClick={() => void load(query, null)}>
            Try again
          </Button>
        </div>
      ) : services.length === 0 ? (
        hasServiceFilters(query) ? (
          <EmptyList icon="search" title="No services match your search">
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
          <EmptyList icon="briefcase" title="No services listed yet">
            Services appear here once providers list them with a price or quote option and the states they cover.
          </EmptyList>
        )
      ) : (
        <>
          <ul aria-label="Services" className="flex flex-col gap-3">
            {services.map((s) => (
              <li key={s.id}>
                <ServiceCardView service={s} />
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
                  : "Load more services"}
            </Button>
          ) : (
            <p className="py-2 text-center text-xs text-muted-foreground">
              That&rsquo;s every service matching your search.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  hint,
  value,
  onChange,
  options,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  className: string;
}) {
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
