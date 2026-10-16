import "server-only";
import { ObjectId } from "mongodb";
import type { Role } from "@/lib/auth/types";
import { PRODUCT_LIMITS, type MarketProduct, type Product, type ProductFields } from "@/lib/orders/types";
import {
  validatePriceKobo,
  validateProductCategory,
  validateProductDescription,
  validateProductName,
  validateProductUnit,
  validateStockQuantity,
} from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type ProductDoc, type UserDoc } from "./models";

// Product listings. Only poultry farmers sell. A seller's own listings are
// always looked up by id *and* the session's account, so someone else's id
// behaves exactly like one that doesn't exist. Removed listings are archived
// (orders keep referring to them) and never shown again.

export const SELLER_ROLE: Role = "poultry-farmer";
export const PRODUCTS_UNVERIFIED = "Verify your phone number before using the Market.";
export const PRODUCT_NOT_FOUND = "We couldn't find that product. It may have been removed.";

export function requireSeller(role: Role) {
  if (role !== SELLER_ROLE) throw new HttpError(403, "Only poultry farmers can list products.");
}

async function products() {
  return (await getDb()).collection<ProductDoc>(COLLECTIONS.products);
}

/** A strict 24-hex-digit id, or null (ObjectId.isValid also accepts 12-byte strings). */
export function parseObjectId(id: unknown): ObjectId | null {
  return typeof id === "string" && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}

export function toProduct(doc: ProductDoc): Product {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    category: doc.category,
    description: doc.description,
    unit: doc.unit,
    priceKobo: doc.priceKobo,
    stockQuantity: doc.stockQuantity,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// --- validation -----------------------------------------------------------------

const FIELD_TYPES = {
  name: "string",
  category: "string",
  description: "string",
  unit: "string",
  priceKobo: "number",
  stockQuantity: "number",
  active: "boolean",
} as const satisfies Record<keyof ProductFields, string>;

const isField = (key: string): key is keyof ProductFields => Object.hasOwn(FIELD_TYPES, key);

/**
 * The product fields present in a body, type-checked and with text cleaned.
 * Anything else (seller, archivedAt, timestamps…) is refused, not ignored.
 */
function readFields(body: Record<string, unknown>): Partial<ProductFields> {
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(body)) {
    if (!isField(key)) fieldErrors[key] = "This can't be set on a product.";
    else if (typeof body[key] !== FIELD_TYPES[key]) fieldErrors[key] = "This value isn't valid.";
  }
  if (Object.keys(fieldErrors).length)
    throw new HttpError(400, "Some of these details can't be set on a product.", fieldErrors);
  const fields = { ...body } as Partial<ProductFields>;
  if (fields.name !== undefined) fields.name = cleanText(fields.name);
  if (fields.description !== undefined) fields.description = cleanText(fields.description, true);
  return fields;
}

function throwIfErrors(errors: Record<string, string | undefined>) {
  const fieldErrors: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors)) if (message) fieldErrors[key] = message;
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
}

function check(fields: Partial<ProductFields>) {
  throwIfErrors({
    name: fields.name === undefined ? undefined : validateProductName(fields.name),
    category: fields.category === undefined ? undefined : validateProductCategory(fields.category),
    description: fields.description === undefined ? undefined : validateProductDescription(fields.description),
    unit: fields.unit === undefined ? undefined : validateProductUnit(fields.unit),
    priceKobo: fields.priceKobo === undefined ? undefined : validatePriceKobo(fields.priceKobo),
    stockQuantity: fields.stockQuantity === undefined ? undefined : validateStockQuantity(fields.stockQuantity),
  });
}

export function parseNewProduct(body: Record<string, unknown>): ProductFields {
  const fields = readFields(body);
  throwIfErrors({
    name: fields.name === undefined ? "Enter a name for this product." : undefined,
    category: fields.category === undefined ? "Choose a category." : undefined,
    unit: fields.unit === undefined ? "Choose how it's sold." : undefined,
    priceKobo: fields.priceKobo === undefined ? "Enter a price in naira." : undefined,
    stockQuantity: fields.stockQuantity === undefined ? "Enter how many you have." : undefined,
  });
  check(fields);
  return {
    name: fields.name!,
    category: fields.category!,
    description: fields.description ?? "",
    unit: fields.unit!,
    priceKobo: fields.priceKobo!,
    stockQuantity: fields.stockQuantity!,
    active: fields.active ?? true,
  };
}

export type ProductUpdate = { fields: Partial<ProductFields>; expectedStock: number | null };

/**
 * Changes to a listing. A new stock count must come with the count the
 * seller was looking at (`expectedStockQuantity`), so an order placed in
 * the meantime isn't silently overwritten.
 */
export function parseProductUpdate(body: Record<string, unknown>): ProductUpdate {
  const { expectedStockQuantity, ...rest } = body;
  const fields = readFields(rest);
  if (Object.keys(fields).length === 0) throw new HttpError(400, "There are no changes to save.");
  check(fields);
  if (fields.stockQuantity === undefined) {
    if (expectedStockQuantity !== undefined)
      throw new HttpError(400, "Some of these details can't be set on a product.", {
        expectedStockQuantity: "This is only sent with a new stock count.",
      });
    return { fields, expectedStock: null };
  }
  if (typeof expectedStockQuantity !== "number" || !Number.isSafeInteger(expectedStockQuantity) || expectedStockQuantity < 0)
    throw new HttpError(400, "Reload the page and try again.");
  return { fields, expectedStock: expectedStockQuantity };
}

// --- the seller's own listings -----------------------------------------------------

const ownedBy = (sellerUserId: ObjectId, _id: ObjectId) => ({ _id, sellerUserId, archivedAt: null });

export async function listOwnProducts(sellerUserId: ObjectId): Promise<Product[]> {
  const docs = await (await products())
    .find({ sellerUserId, archivedAt: null })
    .sort({ createdAt: -1, _id: -1 })
    .limit(PRODUCT_LIMITS.perSeller)
    .toArray();
  return docs.map(toProduct);
}

export async function findOwnProduct(sellerUserId: ObjectId, id: string): Promise<ProductDoc | null> {
  const _id = parseObjectId(id);
  return _id ? (await products()).findOne(ownedBy(sellerUserId, _id)) : null;
}

export async function createProduct(sellerUserId: ObjectId, fields: ProductFields): Promise<ProductDoc> {
  const collection = await products();
  if ((await collection.countDocuments({ sellerUserId, archivedAt: null })) >= PRODUCT_LIMITS.perSeller)
    throw new HttpError(
      409,
      `You can list up to ${PRODUCT_LIMITS.perSeller} products. Remove one you no longer sell to add another.`,
    );
  const now = new Date();
  const doc: ProductDoc = { _id: new ObjectId(), sellerUserId, ...fields, archivedAt: null, createdAt: now, updatedAt: now };
  await collection.insertOne(doc);
  return doc;
}

export const STOCK_CHANGED =
  "Your stock changed since you opened this page (an order was placed or cancelled). Reload and try again.";

/**
 * Applies a validated update; null if it isn't the seller's. A new stock
 * count replaces the current one only if it's still what the seller saw.
 */
export async function updateOwnProduct(
  sellerUserId: ObjectId,
  id: string,
  update: ProductUpdate,
): Promise<ProductDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  const collection = await products();
  const filter = update.expectedStock === null ? ownedBy(sellerUserId, _id) : { ...ownedBy(sellerUserId, _id), stockQuantity: update.expectedStock };
  const saved = await collection.findOneAndUpdate(
    filter,
    { $set: { ...update.fields, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!saved && update.expectedStock !== null && (await collection.findOne(ownedBy(sellerUserId, _id))))
    throw new HttpError(409, STOCK_CHANGED);
  return saved;
}

export async function archiveOwnProduct(sellerUserId: ObjectId, id: string): Promise<boolean> {
  const _id = parseObjectId(id);
  if (!_id) return false;
  const now = new Date();
  const result = await (await products()).updateOne(ownedBy(sellerUserId, _id), {
    $set: { archivedAt: now, active: false, updatedAt: now },
  });
  return result.matchedCount === 1;
}

// --- the Market ---------------------------------------------------------------------

export const MARKET_PAGE_SIZE = 24;

async function sellerNames(ids: ObjectId[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await (await getDb())
    .collection<UserDoc>(COLLECTIONS.users)
    .find({ _id: { $in: ids } })
    .project<Pick<UserDoc, "_id" | "fullName">>({ fullName: 1 })
    .toArray();
  return new Map(users.map((u) => [u._id.toHexString(), u.fullName]));
}

function toMarketProduct(doc: ProductDoc, names: Map<string, string>, viewerId: ObjectId): MarketProduct {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    category: doc.category,
    description: doc.description,
    unit: doc.unit,
    priceKobo: doc.priceKobo,
    stockQuantity: doc.stockQuantity,
    sellerName: names.get(doc.sellerUserId.toHexString()) ?? "Farm Korret seller",
    own: doc.sellerUserId.equals(viewerId),
  };
}

/** Listed products that are in stock, newest first. */
export async function listMarket(viewerId: ObjectId, page: number): Promise<{ products: MarketProduct[]; hasMore: boolean }> {
  const docs = await (await products())
    .find({ active: true, archivedAt: null, stockQuantity: { $gt: 0 } })
    .sort({ createdAt: -1, _id: -1 })
    .skip((Math.max(1, page) - 1) * MARKET_PAGE_SIZE)
    .limit(MARKET_PAGE_SIZE + 1)
    .toArray();
  const shown = docs.slice(0, MARKET_PAGE_SIZE);
  const names = await sellerNames([...new Set(shown.map((d) => d.sellerUserId.toHexString()))].map((id) => new ObjectId(id)));
  return { products: shown.map((d) => toMarketProduct(d, names, viewerId)), hasMore: docs.length > MARKET_PAGE_SIZE };
}

/** One listed product (even when sold out), or null. */
export async function findMarketProduct(viewerId: ObjectId, id: string): Promise<MarketProduct | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  const doc = await (await products()).findOne({ _id, active: true, archivedAt: null });
  if (!doc) return null;
  return toMarketProduct(doc, await sellerNames([doc.sellerUserId]), viewerId);
}
