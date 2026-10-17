// The Market's search and filters, as they appear in the URL. One parser is
// used by the page (on the server, where it decides what is queried) and by
// the search controls (in the browser, to build links), so a copied link
// always restores the same results. Anything unrecognised is dropped rather
// than guessed at, and the page redirects to the cleaned-up address.
//
//   q          keywords                         /market?q=layer+eggs
//   category   a product category value         /market?category=eggs
//   state      only products in this state      /market?state=enugu
//   near       the buyer's state: shown first,  /market?near=lagos
//              other states still appear
//   minPrice   naira per unit, whole numbers    /market?minPrice=1000&maxPrice=10000
//   maxPrice
//   minRating  1-5: average of published reviews
//   stock=all  include sold-out listings (in stock only by default)
//   sort       recommended | newest | price_asc | price_desc | rating
//   page       1-based

import { parseNigerianState, stateLabel, type NigerianState } from "@/lib/locations/nigeria";
import { PRODUCT_CATEGORIES, PRODUCT_LIMITS, type ProductCategory } from "@/lib/orders/types";

export const MARKET_SORTS = [
  { value: "recommended", label: "Recommended" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Highest rated" },
] as const;

export type MarketSort = (typeof MARKET_SORTS)[number]["value"];

export const MARKET_LIMITS = {
  /** characters and words kept from a search */
  query: { max: 80, words: 8 },
  pageSize: 24,
  /** deeper pages aren't offered; narrowing the search is more useful */
  maxPage: 100,
  /** results are counted up to this many ("1,000+") */
  countCap: 1_000,
  /** the price filter, in whole naira, follows the listing price limits */
  priceNaira: { min: PRODUCT_LIMITS.priceKobo.min / 100, max: PRODUCT_LIMITS.priceKobo.max / 100 },
} as const;

/** the minimum-rating choices offered in the filters */
export const RATING_FILTERS = [4, 3] as const;

export type MarketQuery = {
  q: string | null;
  category: ProductCategory | null;
  state: NigerianState | null;
  near: NigerianState | null;
  minPriceKobo: number | null;
  maxPriceKobo: number | null;
  minRating: number | null;
  includeSoldOut: boolean;
  sort: MarketSort;
  page: number;
};

export const DEFAULT_MARKET_QUERY: MarketQuery = {
  q: null,
  category: null,
  state: null,
  near: null,
  minPriceKobo: null,
  maxPriceKobo: null,
  minRating: null,
  includeSoldOut: false,
  sort: "recommended",
  page: 1,
};

export type MarketParams = Record<string, string | string[] | undefined> | URLSearchParams;

function read(params: MarketParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

/**
 * Search words as they're matched: letters and numbers only (so nothing
 * reaches MongoDB as a phrase or negation operator), single-spaced, at most
 * MARKET_LIMITS.query words and characters. null when nothing is left.
 */
export function cleanSearchText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const words = value
    .slice(0, 500)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, MARKET_LIMITS.query.words);
  let text = "";
  for (const word of words) {
    const next = text ? `${text} ${word}` : word;
    if (next.length > MARKET_LIMITS.query.max) break;
    text = next;
  }
  return text || null;
}

const isCategory = (value: unknown): value is ProductCategory =>
  typeof value === "string" && PRODUCT_CATEGORIES.some((c) => c.value === value);

const isSort = (value: unknown): value is MarketSort => typeof value === "string" && MARKET_SORTS.some((s) => s.value === value);

/** Whole naira ("4500", "4,500") as kobo, within the listing price limits; otherwise null. */
export function nairaToKobo(value: string | undefined): number | null {
  const digits = value?.trim().replace(/[,\s]/g, "");
  if (!digits || !/^\d{1,9}$/.test(digits)) return null;
  const naira = Number(digits);
  const { min, max } = MARKET_LIMITS.priceNaira;
  return naira >= min && naira <= max ? naira * 100 : null;
}

function wholeNumber(value: string | undefined, min: number, max: number): number | null {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= min && n <= max ? n : null;
}

/** The query a set of URL parameters describes; invalid values fall back to their defaults. */
export function parseMarketQuery(params: MarketParams): MarketQuery {
  let minPriceKobo = nairaToKobo(read(params, "minPrice"));
  let maxPriceKobo = nairaToKobo(read(params, "maxPrice"));
  if (minPriceKobo !== null && maxPriceKobo !== null && minPriceKobo > maxPriceKobo)
    [minPriceKobo, maxPriceKobo] = [maxPriceKobo, minPriceKobo];
  const category = read(params, "category");
  const sort = read(params, "sort");
  const state = parseNigerianState(read(params, "state"));
  return {
    q: cleanSearchText(read(params, "q")),
    category: isCategory(category) ? category : null,
    state,
    // a state filter already limits the results to one state
    near: state ? null : parseNigerianState(read(params, "near")),
    minPriceKobo,
    maxPriceKobo,
    minRating: wholeNumber(read(params, "minRating"), 1, 5),
    includeSoldOut: read(params, "stock") === "all",
    sort: isSort(sort) ? sort : "recommended",
    page: wholeNumber(read(params, "page"), 1, MARKET_LIMITS.maxPage) ?? 1,
  };
}

/** The canonical /market address for a query (defaults left out). */
export function marketHref(query: MarketQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.state) params.set("state", query.state);
  if (query.near && !query.state) params.set("near", query.near);
  if (query.minPriceKobo !== null) params.set("minPrice", String(query.minPriceKobo / 100));
  if (query.maxPriceKobo !== null) params.set("maxPrice", String(query.maxPriceKobo / 100));
  if (query.minRating !== null) params.set("minRating", String(query.minRating));
  if (query.includeSoldOut) params.set("stock", "all");
  if (query.sort !== "recommended") params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  const search = params.toString();
  return search ? `/market?${search}` : "/market";
}

/** The query with some values changed. Any change other than the page goes back to page 1. */
export const withChanges = (query: MarketQuery, changes: Partial<MarketQuery>): MarketQuery => ({
  ...query,
  page: 1,
  ...changes,
});

export type ActiveFilter = { key: string; label: string; clear: Partial<MarketQuery> };

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG")}`;

/** The filters in effect, each with what clears it (for the removable chips). */
export function activeFilters(query: MarketQuery): ActiveFilter[] {
  const filters: ActiveFilter[] = [];
  if (query.q) filters.push({ key: "q", label: `“${query.q}”`, clear: { q: null } });
  const category = PRODUCT_CATEGORIES.find((c) => c.value === query.category);
  if (category) filters.push({ key: "category", label: category.label, clear: { category: null } });
  if (query.state) filters.push({ key: "state", label: `In ${stateLabel(query.state)}`, clear: { state: null } });
  if (query.near) filters.push({ key: "near", label: `${stateLabel(query.near)} first`, clear: { near: null } });
  const { minPriceKobo: min, maxPriceKobo: max } = query;
  if (min !== null || max !== null)
    filters.push({
      key: "price",
      label: min !== null && max !== null ? `${naira(min)} – ${naira(max)}` : min !== null ? `From ${naira(min)}` : `Up to ${naira(max!)}`,
      clear: { minPriceKobo: null, maxPriceKobo: null },
    });
  if (query.minRating !== null) filters.push({ key: "minRating", label: `${query.minRating}★ & up`, clear: { minRating: null } });
  if (query.includeSoldOut) filters.push({ key: "stock", label: "Including sold out", clear: { includeSoldOut: false } });
  return filters;
}

/** How many of the filter sheet's settings are in use (the Filters button's badge). */
export const sheetFilterCount = (query: MarketQuery) =>
  [query.state, query.near, query.minPriceKobo ?? query.maxPriceKobo, query.minRating, query.includeSoldOut ? true : null].filter(
    (v) => v !== null,
  ).length;
