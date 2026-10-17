import "server-only";
import type { Document, Filter, ObjectId } from "mongodb";
import { MARKET_LIMITS, type MarketQuery } from "@/lib/market/query";
import type { MarketProduct } from "@/lib/orders/types";
import { getDb } from "./db";
import { COLLECTIONS, type ProductDoc } from "./models";
import { sellerNames, toMarketProduct } from "./products";

// Searching the Market. Every query runs in MongoDB against indexed fields
// (see indexes.ts); nothing is filtered or ranked in memory, and only one
// page plus one extra row is read.
//
// What's shown: listed products only (active, not archived), and only those
// in stock unless the buyer asks for sold-out ones too. The buyer's own
// listings appear, marked as theirs (they can't buy them). Listings without
// a location appear everywhere except under an explicit state filter.
//
// Keywords use the products text index, which matches whole words after
// English stemming ("eggs" finds "egg"), ignoring case and accents, against
// three fields with these weights:
//   name 10, searchTerms 3 (the category's name and everyday words for it), description 2.
// Several words match listings with any of them, the best matches first.
//
// Ranking ("recommended", the default):
//   - with keywords: MongoDB's text relevance score, multiplied by NEAR_BOOST
//     for listings in the buyer's preferred state (`near`);
//   - without keywords but with `near`: listings in that state first;
//   - otherwise newest first.
//   Ties are always broken newest first, then by id, so pages are stable.
// Other sorts:
//   newest       createdAt, id
//   price_asc    price, then newest
//   price_desc   price, then oldest (the same index read backwards)
//   rating       average of published reviews, then their number, then newest;
//                products without reviews come last
// Nothing is ranked by popularity: there's no data for it.

/** How much a listing in the buyer's state is favoured in keyword results. */
export const NEAR_BOOST = 1.25;

/** The MongoDB filter for a query: visibility rules first, then the buyer's filters. */
export function marketFilter(query: MarketQuery): Filter<ProductDoc> {
  const filter: Filter<ProductDoc> = { active: true, archivedAt: null };
  if (!query.includeSoldOut) filter.stockQuantity = { $gt: 0 };
  if (query.category) filter.category = query.category;
  if (query.state) filter.state = query.state;
  if (query.minPriceKobo !== null || query.maxPriceKobo !== null)
    filter.priceKobo = {
      ...(query.minPriceKobo !== null && { $gte: query.minPriceKobo }),
      ...(query.maxPriceKobo !== null && { $lte: query.maxPriceKobo }),
    };
  if (query.minRating !== null) filter.ratingAverage = { $gte: query.minRating };
  if (query.q) filter.$text = { $search: query.q, $caseSensitive: false, $diacriticSensitive: false };
  return filter;
}

const inNearState = (query: MarketQuery) => ({ $eq: ["$state", query.near] });

/** The sort for a query, with the computed `rank` field it relies on (if any). */
export function marketOrder(query: MarketQuery): { rank: Document | null; sort: Record<string, 1 | -1> } {
  switch (query.sort) {
    case "newest":
      return { rank: null, sort: { createdAt: -1, _id: -1 } };
    case "price_asc":
      return { rank: null, sort: { priceKobo: 1, _id: -1 } };
    case "price_desc":
      return { rank: null, sort: { priceKobo: -1, _id: 1 } };
    case "rating":
      return { rank: null, sort: { ratingAverage: -1, ratingCount: -1, _id: -1 } };
    case "recommended":
      if (query.q) {
        const score = { $meta: "textScore" };
        return {
          rank: query.near ? { $multiply: [score, { $cond: [inNearState(query), NEAR_BOOST, 1] }] } : score,
          sort: { rank: -1, createdAt: -1, _id: -1 },
        };
      }
      if (query.near) return { rank: { $cond: [inNearState(query), 1, 0] }, sort: { rank: -1, createdAt: -1, _id: -1 } };
      return { rank: null, sort: { createdAt: -1, _id: -1 } };
  }
}

export type MarketResults = {
  products: MarketProduct[];
  page: number;
  hasMore: boolean;
  /** how many products match, counted up to MARKET_LIMITS.countCap */
  total: number;
  /** true when there are more than `total` */
  totalCapped: boolean;
};

const PROJECTION = {
  sellerUserId: 1,
  name: 1,
  category: 1,
  description: 1,
  unit: 1,
  priceKobo: 1,
  stockQuantity: 1,
  state: 1,
  area: 1,
  ratingCount: 1,
  ratingAverage: 1,
  fulfillment: 1,
  // cards only show the main photo (null on listings without photos)
  images: { $slice: ["$images", 1] },
} as const;

/** One page of the Market for a validated query (see parseMarketQuery). */
export async function searchMarket(viewerId: ObjectId, query: MarketQuery): Promise<MarketResults> {
  const products = (await getDb()).collection<ProductDoc>(COLLECTIONS.products);
  const filter = marketFilter(query);
  const { rank, sort } = marketOrder(query);
  const size = MARKET_LIMITS.pageSize;
  const page = Math.min(Math.max(1, query.page), MARKET_LIMITS.maxPage);

  const pipeline: Document[] = [
    { $match: filter },
    ...(rank ? [{ $addFields: { rank } }] : []),
    { $sort: sort },
    { $skip: (page - 1) * size },
    { $limit: size + 1 },
    { $project: PROJECTION },
  ];
  const [docs, counted] = await Promise.all([
    products.aggregate<ProductDoc>(pipeline).toArray(),
    products.countDocuments(filter, { limit: MARKET_LIMITS.countCap + 1 }),
  ]);
  const shown = docs.slice(0, size);
  const names = await sellerNames([...new Map(shown.map((d) => [d.sellerUserId.toHexString(), d.sellerUserId])).values()]);
  return {
    products: shown.map((d) => toMarketProduct(d, names, viewerId)),
    page,
    hasMore: docs.length > size && page < MARKET_LIMITS.maxPage,
    total: Math.min(counted, MARKET_LIMITS.countCap),
    totalCapped: counted > MARKET_LIMITS.countCap,
  };
}

/**
 * searchMarket for the Market page: null if the search couldn't run, so the
 * page keeps the buyer's search and filters on screen with a way to retry.
 * Only the error's name is logged, never the query or the database's message.
 */
export async function trySearchMarket(viewerId: ObjectId, query: MarketQuery): Promise<MarketResults | null> {
  try {
    return await searchMarket(viewerId, query);
  } catch (error) {
    console.error(`[market-search] failed: ${error instanceof Error ? error.name : typeof error}`);
    return null;
  }
}
