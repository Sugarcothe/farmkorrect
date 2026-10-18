import { isNigerianState } from "@/lib/locations/nigeria";
import { SPECIALIZATIONS } from "@/lib/profile/config";
import { SERVICE_CATEGORIES } from "@/lib/services/config";
import { isDateString } from "./schedule";
import { DIRECTORY_SORTS, type DirectoryQuery, type DirectorySort } from "./types";

// Directory filters, read the same way by the page (from its URL), the
// browser (to call the API) and the API itself. One canonical form per
// search: the cursor is bound to it, so a page of one search can't be used
// to continue another.

export const VET_QUERY_LIMITS = { words: 5, wordMin: 2, max: 60 } as const;

export const DEFAULT_QUERY: DirectoryQuery = {
  q: "",
  state: null,
  specialty: null,
  service: null,
  date: null,
  sort: "experience",
};

/** Lower-case words of letters and digits (accents removed), as the directory stores them. */
export function searchWords(text: string): string[] {
  return text
    .slice(0, 500)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= VET_QUERY_LIMITS.wordMin);
}

/** The search box text, cleaned: at most 5 words and 60 characters. */
export function cleanVetSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = "";
  for (const word of searchWords(value).slice(0, VET_QUERY_LIMITS.words)) {
    const next = text ? `${text} ${word}` : word;
    if (next.length > VET_QUERY_LIMITS.max) break;
    text = next;
  }
  return text;
}

export const isVetSpecialty = (value: unknown): value is string =>
  SPECIALIZATIONS.veterinarian.some((o) => o.value === value);
export const isVetServiceCategory = (value: unknown): value is string =>
  SERVICE_CATEGORIES.veterinarian.some((c) => c.value === value);
const isSort = (value: unknown): value is DirectorySort => DIRECTORY_SORTS.some((s) => s.value === value);

export type ParsedDirectoryQuery = { query: DirectoryQuery; invalid: string[] };

/**
 * Reads the filters from URL parameters. Anything unrecognised is dropped
 * and named in `invalid` (the API refuses those; a page just ignores them).
 */
export function parseDirectoryQuery(params: URLSearchParams): ParsedDirectoryQuery {
  const invalid: string[] = [];
  const pick = <T>(key: string, valid: (v: unknown) => v is T): T | null => {
    const raw = params.get(key);
    if (raw === null || raw === "") return null;
    if (valid(raw)) return raw;
    invalid.push(key);
    return null;
  };
  const sort = pick("sort", isSort);
  return {
    query: {
      q: cleanVetSearch(params.get("q") ?? ""),
      state: pick("state", isNigerianState),
      specialty: pick("specialty", isVetSpecialty),
      service: pick("service", isVetServiceCategory),
      date: pick("date", isDateString),
      sort: sort ?? DEFAULT_QUERY.sort,
    },
    invalid,
  };
}

/** URL parameters for a query, defaults left out, always in the same order. */
export function queryParams(query: DirectoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.state) params.set("state", query.state);
  if (query.specialty) params.set("specialty", query.specialty);
  if (query.service) params.set("service", query.service);
  if (query.date) params.set("date", query.date);
  if (query.sort !== DEFAULT_QUERY.sort) params.set("sort", query.sort);
  return params;
}

/** The canonical text a cursor is bound to. */
export const canonicalQuery = (query: DirectoryQuery) => queryParams(query).toString();

export const hasFilters = (query: DirectoryQuery) =>
  Boolean(query.q || query.state || query.specialty || query.service || query.date);
