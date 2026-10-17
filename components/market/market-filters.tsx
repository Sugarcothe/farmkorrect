"use client";

import { useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { isNigerianState, NIGERIAN_STATES } from "@/lib/locations/nigeria";
import {
  MARKET_SORTS,
  marketHref,
  nairaToKobo,
  RATING_FILTERS,
  sheetFilterCount,
  withChanges,
  type MarketQuery,
  type MarketSort,
} from "@/lib/market/query";

const ANY = "any";
const STATE_FILTER_OPTIONS = [{ value: ANY, label: "All of Nigeria" }, ...NIGERIAN_STATES];
const NEAR_OPTIONS = [{ value: ANY, label: "No preference" }, ...NIGERIAN_STATES];

type Draft = {
  state: string;
  near: string;
  minPrice: string;
  maxPrice: string;
  minRating: string;
  includeSoldOut: boolean;
};

const toDraft = (q: MarketQuery): Draft => ({
  state: q.state ?? ANY,
  near: q.near ?? ANY,
  minPrice: q.minPriceKobo === null ? "" : String(q.minPriceKobo / 100),
  maxPrice: q.maxPriceKobo === null ? "" : String(q.maxPriceKobo / 100),
  minRating: q.minRating === null ? "" : String(q.minRating),
  includeSoldOut: q.includeSoldOut,
});

const PRICE_ERROR = "Enter whole naira, like 4500.";

/**
 * The Filters button and its sheet (state, preferred state, price, rating,
 * sold-out listings), plus the sort menu. Nothing changes until "Show
 * results"; the address then holds every choice, so the results can be
 * shared or revisited.
 */
export function MarketFilters({ query }: { query: MarketQuery }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(query));
  const [errors, setErrors] = useState<{ minPrice?: string; maxPrice?: string }>({});
  const [pending, startTransition] = useTransition();
  const count = sheetFilterCount(query);

  const go = (next: MarketQuery) => startTransition(() => router.push(marketHref(next), { scroll: false }));

  function open() {
    setDraft(toDraft(query));
    setErrors({});
    dialogRef.current?.showModal();
  }

  const close = () => dialogRef.current?.close();

  const set =
    (key: keyof Draft) =>
    (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setDraft((d) => ({ ...d, [key]: e.target.value }));

  function apply(e: FormEvent) {
    e.preventDefault();
    const min = draft.minPrice.trim() ? nairaToKobo(draft.minPrice) : null;
    const max = draft.maxPrice.trim() ? nairaToKobo(draft.maxPrice) : null;
    const next = {
      minPrice: draft.minPrice.trim() && min === null ? PRICE_ERROR : undefined,
      maxPrice: draft.maxPrice.trim() && max === null ? PRICE_ERROR : undefined,
    };
    setErrors(next);
    if (next.minPrice || next.maxPrice) return;
    const state = isNigerianState(draft.state) ? draft.state : null;
    close();
    go(
      withChanges(query, {
        state,
        near: state ? null : isNigerianState(draft.near) ? draft.near : null,
        // the lower one is always the minimum
        minPriceKobo: min !== null && max !== null ? Math.min(min, max) : min,
        maxPriceKobo: min !== null && max !== null ? Math.max(min, max) : max,
        minRating: draft.minRating ? Number(draft.minRating) : null,
        includeSoldOut: draft.includeSoldOut,
      }),
    );
  }

  function reset() {
    close();
    go(withChanges(query, { state: null, near: null, minPriceKobo: null, maxPriceKobo: null, minRating: null, includeSoldOut: false }));
  }

  const chip = (selected: boolean) =>
    `flex h-10 flex-1 items-center justify-center rounded-full px-3 text-sm font-medium ring-1 outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
      selected ? "bg-primary text-primary-foreground ring-primary" : "bg-white text-foreground/75 ring-foreground/10 hover:bg-primary/5"
    }`;

  return (
    <div className="flex items-center gap-2" aria-busy={pending || undefined}>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        className="flex h-10 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-medium text-primary ring-1 ring-foreground/8 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Icon name="sliders" className="size-4" />
        Filters
        {count > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] font-semibold text-primary-foreground">
            {count}
            <span className="sr-only"> in use</span>
          </span>
        )}
      </button>

      <label className="relative ml-auto flex h-10 items-center rounded-full bg-white ring-1 ring-foreground/8 focus-within:ring-2 focus-within:ring-accent">
        <span className="sr-only">Sort by</span>
        <select
          value={query.sort}
          onChange={(e) => go(withChanges(query, { sort: e.target.value as MarketSort }))}
          className="h-full cursor-pointer appearance-none rounded-full bg-transparent pr-9 pl-4 text-sm font-medium text-foreground outline-none"
        >
          {MARKET_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" className="pointer-events-none absolute right-3 size-4 text-foreground/50" />
      </label>

      <dialog
        ref={dialogRef}
        aria-labelledby="market-filters-title"
        className="mx-auto mt-auto mb-0 max-h-[88dvh] w-full max-w-[420px] overflow-y-auto rounded-t-3xl bg-surface p-0 text-foreground backdrop:bg-black/40 md:mb-auto md:rounded-3xl"
      >
        <form onSubmit={apply} noValidate className="flex flex-col gap-4 px-5 pt-4 pb-6">
          <div className="flex items-center justify-between">
            <h2 id="market-filters-title" className="text-lg font-semibold">
              Filters
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close filters"
              className="flex size-10 items-center justify-center rounded-full outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon name="x" />
            </button>
          </div>

          <SelectField
            name="state"
            label="Only show products in"
            placeholder="All of Nigeria"
            options={STATE_FILTER_OPTIONS}
            value={draft.state}
            onChange={set("state")}
          />
          <SelectField
            name="near"
            label="Your state (shown first)"
            placeholder="No preference"
            options={NEAR_OPTIONS}
            value={isNigerianState(draft.state) ? ANY : draft.near}
            onChange={set("near")}
            disabled={isNigerianState(draft.state)}
            hint={
              isNigerianState(draft.state)
                ? "Not needed while results are limited to one state."
                : "Products from your state come first; the rest of Nigeria still shows."
            }
          />

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Price per unit (₦)</legend>
            <div className="grid grid-cols-2 gap-3">
              <TextField name="minPrice" label="Minimum" inputMode="numeric" placeholder="e.g. 1,000" value={draft.minPrice} onChange={set("minPrice")} error={errors.minPrice} />
              <TextField name="maxPrice" label="Maximum" inputMode="numeric" placeholder="e.g. 10,000" value={draft.maxPrice} onChange={set("maxPrice")} error={errors.maxPrice} />
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Customer rating</legend>
            <div className="flex gap-2">
              {[{ value: "", label: "Any" }, ...RATING_FILTERS.map((r) => ({ value: String(r), label: `${r}★ & up` }))].map((option) => (
                <label key={option.value || "any"} className={chip(draft.minRating === option.value)}>
                  <input
                    type="radio"
                    name="minRating"
                    value={option.value}
                    checked={draft.minRating === option.value}
                    onChange={set("minRating")}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">From published reviews. Products without reviews are left out.</p>
          </fieldset>

          <div className="rounded-2xl bg-white px-4 py-3.5 ring-1 ring-foreground/8">
            <Switch
              label="Include sold-out listings"
              checked={draft.includeSoldOut}
              onChange={(checked) => setDraft((d) => ({ ...d, includeSoldOut: checked }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <Button type="button" variant="outline" onClick={reset}>
              Reset
            </Button>
            <Button type="submit">Show results</Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
