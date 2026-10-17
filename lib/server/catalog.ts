import type { AnyBulkWriteOperation, Db, ObjectId } from "mongodb";
import { PRODUCT_CATEGORIES, type ProductCategory } from "@/lib/orders/types";
import { COLLECTIONS, type ProductDoc, type ReviewDoc } from "./models";

// Search data stored on each product, derived from data held elsewhere so
// the Market can filter and sort with indexes instead of joining reviews or
// matching synonyms at request time. Nothing here is ever taken from a
// request, and all of it can be rebuilt from the source records with
// rebuildCatalogSearch (`npm run db:rebuild-search`). No "server-only"
// import, so the maintenance script can use it.

/**
 * The everyday words buyers use for each category, matched alongside the
 * category's own name. They only ever widen what a category's listings can
 * be found by; they never pick out particular products.
 */
export const CATEGORY_SEARCH_TERMS: Record<ProductCategory, string> = {
  "live-birds": "chicken chickens broiler broilers layer layers cockerel cockerels hen hens rooster turkey fowl poultry",
  eggs: "egg eggs crate crates table eggs layer eggs",
  "dressed-chicken": "chicken meat frozen chicken processed chicken slaughtered poultry",
  "day-old-chicks": "chick chicks doc docs day old hatchery broiler chicks layer chicks",
  manure: "manure droppings fertiliser fertilizer compost poultry litter",
  other: "farm produce",
};

/** What a product of this category is found by, besides its name and description. */
export function searchTermsFor(category: ProductCategory): string {
  const label = PRODUCT_CATEGORIES.find((c) => c.value === category)?.label ?? "";
  return `${label} ${CATEGORY_SEARCH_TERMS[category] ?? ""}`.trim().toLowerCase();
}

/** Published reviews only; the average is rounded to one decimal place, as on the product page. */
function summarise(group: { count: number; sum: number } | undefined) {
  const count = group?.count ?? 0;
  return { ratingCount: count, ratingAverage: count === 0 ? null : Math.round((group!.sum / count) * 10) / 10 };
}

/**
 * Recounts a product's published reviews into its rating summary. Call it
 * after any change to one of its reviews. Each refresh first claims a
 * generation number and only saves if no later refresh has started since,
 * so the summary always ends up reflecting the latest change.
 */
export async function refreshProductRating(db: Db, productId: ObjectId): Promise<void> {
  const products = db.collection<ProductDoc>(COLLECTIONS.products);
  const claimed = await products.findOneAndUpdate(
    { _id: productId },
    { $inc: { ratingGen: 1 } },
    { returnDocument: "after", projection: { ratingGen: 1 } },
  );
  if (!claimed) return;
  const [group] = await db
    .collection<ReviewDoc>(COLLECTIONS.reviews)
    .aggregate<{ count: number; sum: number }>([
      { $match: { productId, status: "published" } },
      { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: "$rating" } } },
    ])
    .toArray();
  await products.updateOne({ _id: productId, ratingGen: claimed.ratingGen }, { $set: summarise(group) });
}

/**
 * Recomputes every product's search terms and rating summary from the
 * categories and published reviews. Safe to run at any time and repeatedly;
 * needed once after deploying search (to fill in existing listings) and
 * after review statuses are changed directly in the database.
 */
export async function rebuildCatalogSearch(db: Db, batchSize = 500): Promise<{ products: number }> {
  const products = db.collection<ProductDoc>(COLLECTIONS.products);
  const reviews = db.collection<ReviewDoc>(COLLECTIONS.reviews);
  type Row = Pick<ProductDoc, "_id" | "category" | "ratingGen">;

  // Products are read in batches and each batch's reviews are counted after
  // it's read. Every write only applies if nothing changed the product since
  // it was read: a seller changing the category saves its own terms, and a
  // rating refresh that started since then has counted at least as much.
  async function rebuild(rows: Row[]) {
    const groups = await reviews
      .aggregate<{ _id: ObjectId; count: number; sum: number }>([
        { $match: { productId: { $in: rows.map((r) => r._id) }, status: "published" } },
        { $group: { _id: "$productId", count: { $sum: 1 }, sum: { $sum: "$rating" } } },
      ])
      .toArray();
    const ratings = new Map(groups.map((g) => [g._id.toHexString(), g]));
    const writes: AnyBulkWriteOperation<ProductDoc>[] = rows.flatMap((row) => [
      {
        updateOne: {
          filter: { _id: row._id, category: row.category },
          update: { $set: { searchTerms: searchTermsFor(row.category) } },
        },
      },
      {
        updateOne: {
          filter: { _id: row._id, ratingGen: row.ratingGen ?? { $exists: false } },
          update: { $set: summarise(ratings.get(row._id.toHexString())) },
        },
      },
    ]);
    await products.bulkWrite(writes, { ordered: false });
  }

  let count = 0;
  let rows: Row[] = [];
  for await (const row of products.find({}, { projection: { _id: 1, category: 1, ratingGen: 1 } })) {
    rows.push(row as Row);
    if (rows.length >= batchSize) {
      await rebuild(rows);
      count += rows.length;
      rows = [];
    }
  }
  if (rows.length) {
    await rebuild(rows);
    count += rows.length;
  }
  return { products: count };
}
