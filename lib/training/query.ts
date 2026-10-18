import { searchWords } from "@/lib/vets/query";
import { isCourseCategory, isDifficulty, SEARCH_LIMITS, type CatalogQuery } from "./types";

// Catalogue filters, read the same way by the page (from its URL), the
// browser and the API. One canonical form per search: the cursor is bound to
// it, so a page of one search can't be used to continue another.

export const EMPTY_QUERY: CatalogQuery = { q: "", category: null, difficulty: null };

export { searchWords };

/** The search box text, cleaned: at most 5 words and 60 characters. */
export function cleanSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = "";
  for (const word of searchWords(value).slice(0, SEARCH_LIMITS.words)) {
    const next = text ? `${text} ${word}` : word;
    if (next.length > SEARCH_LIMITS.max) break;
    text = next;
  }
  return text;
}

/**
 * Reads the filters from URL parameters. Anything unrecognised is dropped
 * and named in `invalid` (the API refuses those; a page just ignores them).
 */
export function parseCatalogQuery(params: URLSearchParams): { query: CatalogQuery; invalid: string[] } {
  const invalid: string[] = [];
  const pick = <T>(key: string, valid: (v: unknown) => v is T): T | null => {
    const raw = params.get(key);
    if (raw === null || raw === "") return null;
    if (valid(raw)) return raw;
    invalid.push(key);
    return null;
  };
  return {
    query: {
      q: cleanSearch(params.get("q") ?? ""),
      category: pick("category", isCourseCategory),
      difficulty: pick("difficulty", isDifficulty),
    },
    invalid,
  };
}

/** URL parameters for a query, empty values left out, always in the same order. */
export function catalogParams(query: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.difficulty) params.set("difficulty", query.difficulty);
  return params;
}

export const canonicalCatalogQuery = (query: CatalogQuery) => catalogParams(query).toString();

export const hasCatalogFilters = (query: CatalogQuery) => Boolean(query.q || query.category || query.difficulty);

/** "1 h 20 min", "12 min", "45 s". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "3:07" or "1:02:05" for a player position. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
