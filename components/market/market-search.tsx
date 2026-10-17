"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { cleanSearchText, marketHref, withChanges, type MarketQuery } from "@/lib/market/query";

/** typing pauses this long before the results update */
const DEBOUNCE_MS = 400;

/**
 * The Market's keyword box. Results update once typing pauses (or straight
 * away on Enter), by changing the address: a new search adds a history
 * entry and refining it replaces that entry, so Back leaves the search
 * rather than stepping through every keystroke. The search itself runs on
 * the server; filters already chosen are kept.
 */
export function MarketSearch({ query }: { query: MarketQuery }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(query.q ?? "");
  const [shownQ, setShownQ] = useState(query.q);
  const [pending, startTransition] = useTransition();

  // The search in the address changed elsewhere (Back, a removed filter
  // chip): show it, unless it's just what's being typed catching up.
  if (query.q !== shownQ) {
    setShownQ(query.q);
    if (cleanSearchText(value) !== query.q) setValue(query.q ?? "");
  }

  useEffect(() => {
    const q = cleanSearchText(value);
    // single letters wait for Enter: they'd match almost nothing
    if (q === query.q || (q !== null && q.length < 2)) return;
    const timer = setTimeout(() => {
      const href = marketHref(withChanges(query, { q }));
      startTransition(() => (query.q ? router.replace(href, { scroll: false }) : router.push(href, { scroll: false })));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, query, router]);

  function search(text: string) {
    const q = cleanSearchText(text);
    if (q === query.q) return;
    const href = marketHref(withChanges(query, { q }));
    startTransition(() => (query.q && q ? router.replace(href, { scroll: false }) : router.push(href, { scroll: false })));
  }

  function clear() {
    setValue("");
    search("");
    inputRef.current?.focus();
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        search(value);
        inputRef.current?.blur();
      }}
      className="relative"
    >
      <label htmlFor="market-search" className="sr-only">
        Search the Market
      </label>
      <Icon name="search" className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-foreground/45" />
      <input
        ref={inputRef}
        id="market-search"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        maxLength={120}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search eggs, live birds, chicks, chicken and farm produce"
        aria-busy={pending || undefined}
        className="h-12 w-full rounded-full bg-white pr-12 pl-11 text-[0.9375rem] text-foreground shadow-sm ring-1 ring-foreground/8 outline-none placeholder:text-[0.8125rem] placeholder:text-foreground/40 focus:ring-2 focus:ring-accent [&::-webkit-search-cancel-button]:hidden"
      />
      {pending ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 right-4 size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-primary/25 border-t-primary"
        />
      ) : (
        value && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-foreground/55 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="x" className="size-4" />
          </button>
        )
      )}
    </form>
  );
}
