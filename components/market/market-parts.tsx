import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { activeFilters, marketHref, withChanges, type MarketQuery } from "@/lib/market/query";
import { PRODUCT_CATEGORIES } from "@/lib/orders/types";

const chipClass = (selected: boolean) =>
  `flex h-9 shrink-0 items-center rounded-full px-3.5 text-[0.8125rem] font-medium whitespace-nowrap ring-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    selected ? "bg-primary text-primary-foreground ring-primary" : "bg-white text-foreground/75 ring-foreground/8 hover:bg-primary/5"
  }`;

/** Browse a category without typing anything; the search and other filters stay. */
export function CategoryChips({ query }: { query: MarketQuery }) {
  const options = [{ value: null, label: "All" }, ...PRODUCT_CATEGORIES];
  return (
    <nav aria-label="Categories" className="-mx-5 overflow-x-auto px-5 [scrollbar-width:none]">
      <ul className="flex gap-2 pb-1">
        {options.map((c) => {
          const selected = query.category === c.value;
          return (
            <li key={c.value ?? "all"}>
              <Link
                href={marketHref(withChanges(query, { category: c.value }))}
                aria-current={selected ? "page" : undefined}
                scroll={false}
                className={chipClass(selected)}
              >
                {c.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The filters in effect, each removable, and a way back to the whole Market. */
export function ActiveFilters({ query }: { query: MarketQuery }) {
  const filters = activeFilters(query);
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="sr-only">Active filters:</span>
      {filters.map((f) => (
        <Link
          key={f.key}
          href={marketHref(withChanges(query, f.clear))}
          scroll={false}
          aria-label={`Remove filter: ${f.label}`}
          className="flex h-8 max-w-full items-center gap-1 rounded-full bg-primary/8 pr-2 pl-3 text-xs font-medium text-primary outline-none hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="truncate">{f.label}</span>
          <Icon name="x" className="size-3.5 shrink-0" />
        </Link>
      ))}
      <Link
        href="/market"
        scroll={false}
        className="flex h-8 items-center rounded-full px-2.5 text-xs font-medium text-foreground/60 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
      >
        Clear all
      </Link>
    </div>
  );
}

/** Previous / next pages of results, keeping the search and filters. */
export function MarketPager({ query, hasMore }: { query: MarketQuery; hasMore: boolean }) {
  if (query.page <= 1 && !hasMore) return null;
  const linkClass =
    "flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between">
      {query.page > 1 ? (
        <Link href={marketHref({ ...query, page: query.page - 1 })} className={linkClass}>
          <Icon name="arrow-left" className="size-4" />
          Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="text-xs text-muted-foreground">Page {query.page}</span>
      {hasMore ? (
        <Link href={marketHref({ ...query, page: query.page + 1 })} className={linkClass}>
          Next
          <Icon name="chevron-right" className="size-4" />
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
