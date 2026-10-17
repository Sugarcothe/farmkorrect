import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import type { PaymentStatus } from "@/lib/orders/types";
import {
  REVIEW_LIMITS,
  type MyReview,
  type PublicReview,
  type ReviewEligibility,
  type ReviewInput,
  type ReviewStatus,
  type ReviewSummary,
} from "@/lib/reviews/types";
import { cleanReviewText, validateRating, validateReviewText } from "@/lib/reviews/validation";
import { refreshProductRating } from "./catalog";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type OrderDoc, type ProductDoc, type ReviewDoc, type UserDoc } from "./models";
import { queueNotifications, syncReviewNotification } from "./notifications";
import { parseObjectId, PRODUCT_NOT_FOUND } from "./products";

// Product reviews. Who may review is decided here, from the stored orders:
//
// - the reviewer is the signed-in account, never an id from the request;
// - they must have an order for the product that was paid (Paystack
//   confirmed it, so paidAt is set), wasn't cancelled and that the seller
//   marked delivered. Orders refunded after delivery still count: the
//   customer received the product;
// - sellers can't review their own products;
// - one review per customer per product, enforced by a unique index.
//
// Moderation policy: a new review that passes validation is published
// straight away (NEW_REVIEW_STATUS). Admins can publish, reject, remove or
// restore reviews in the admin area (lib/server/admin-reviews.ts), which
// never changes a review's rating or text and never deletes one; pending
// and rejected reviews are never shown publicly or counted. An edit keeps the
// review's status, so a pending review stays pending and a rejected one can't
// be edited, withdrawn or reposted. Withdrawing hides a review; its author may
// then write a new one, which goes through the same checks as a first review.
// Sellers have no way to hide or change reviews of their products.
//
// Each product keeps a summary of its published reviews for the Market's
// rating filter and sort (catalog.ts). It's refreshed after every change
// made here; after changing a review's status directly in the database, run
// `npm run db:rebuild-search` to bring the summaries back in line.

export const REVIEWS_UNVERIFIED = "Verify your phone number before using the Market.";
export const REVIEW_NOT_FOUND = "We couldn't find that review.";
export const ALREADY_REVIEWED = "You've already reviewed this product. You can edit your review from My Reviews.";

export const NEW_REVIEW_STATUS: ReviewStatus = "published";
const EDITABLE: ReviewStatus[] = ["pending", "published"];
/** a confirmed payment, including one later refunded in part or in full */
const PAID: PaymentStatus[] = ["paid", "partially_refunded", "refunded"];

async function db() {
  const database = await getDb();
  return {
    reviews: database.collection<ReviewDoc>(COLLECTIONS.reviews),
    products: database.collection<ProductDoc>(COLLECTIONS.products),
    orders: database.collection<OrderDoc>(COLLECTIONS.orders),
    users: database.collection<UserDoc>(COLLECTIONS.users),
  };
}

/** A product that's on the Market, or null. */
async function listedProduct(id: string): Promise<ProductDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  return (await db()).products.findOne({ _id, active: true, archivedAt: null });
}

// --- validation -------------------------------------------------------------------

const FIELD_TYPES = { rating: "number", text: "string" } as const;
const isField = (key: string): key is keyof ReviewInput => Object.hasOwn(FIELD_TYPES, key);

/**
 * The rating and text in a body, checked and with the text cleaned. Anything
 * else (product, reviewer, order, status, verifiedPurchase…) is refused,
 * not ignored.
 */
function readInput(body: Record<string, unknown>): Partial<ReviewInput> {
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(body)) {
    if (!isField(key)) fieldErrors[key] = "This can't be set on a review.";
    else if (typeof body[key] !== FIELD_TYPES[key]) fieldErrors[key] = "This value isn't valid.";
  }
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Some of these details can't be set on a review.", fieldErrors);

  const input = { ...body } as Partial<ReviewInput>;
  if (input.text !== undefined) input.text = cleanReviewText(input.text);
  const errors = {
    rating: input.rating === undefined ? undefined : validateRating(input.rating),
    text: input.text === undefined ? undefined : validateReviewText(input.text),
  };
  for (const [key, message] of Object.entries(errors)) if (message) fieldErrors[key] = message;
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
  return input;
}

export function parseNewReview(body: Record<string, unknown>): ReviewInput {
  const input = readInput(body);
  const fieldErrors: Record<string, string> = {};
  if (input.rating === undefined) fieldErrors.rating = "Choose a star rating.";
  if (input.text === undefined) fieldErrors.text = "Tell other buyers about this product.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
  return { rating: input.rating!, text: input.text! };
}

export function parseReviewUpdate(body: Record<string, unknown>): Partial<ReviewInput> {
  const input = readInput(body);
  if (Object.keys(input).length === 0) throw new HttpError(400, "There are no changes to save.");
  return input;
}

// --- shaping for the browser ---------------------------------------------------------

/** "Adaeze Okafor" -> "Adaeze O." Nothing else about a reviewer is shown. */
export function displayName(fullName: string | undefined): string {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Farm Korret customer";
  const last = parts.length > 1 ? ` ${Array.from(parts[parts.length - 1])[0].toUpperCase()}.` : "";
  return `${parts[0]}${last}`;
}

function toPublicReview(doc: ReviewDoc, names: Map<string, string>): PublicReview {
  return {
    id: doc._id.toHexString(),
    reviewerName: displayName(names.get(doc.reviewerUserId.toHexString())),
    rating: doc.rating,
    text: doc.text,
    verifiedPurchase: doc.verifiedPurchase,
    createdAt: doc.createdAt.toISOString(),
    editedAt: doc.editedAt?.toISOString() ?? null,
  };
}

export function toMyReview(doc: ReviewDoc, product: Pick<ProductDoc, "name" | "active" | "archivedAt"> | null): MyReview {
  return {
    id: doc._id.toHexString(),
    productId: doc.productId.toHexString(),
    productName: product?.name ?? "A removed product",
    productListed: !!product && product.active && product.archivedAt === null,
    rating: doc.rating,
    text: doc.text,
    status: doc.status,
    verifiedPurchase: doc.verifiedPurchase,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    editedAt: doc.editedAt?.toISOString() ?? null,
  };
}

// --- eligibility ------------------------------------------------------------------------

/** The customer's earliest paid, delivered and uncancelled order for the product, or null. */
async function qualifyingOrder(userId: ObjectId, productId: ObjectId): Promise<OrderDoc | null> {
  const [order] = await (await db()).orders
    .find({
      buyerUserId: userId,
      "items.productId": productId,
      paymentStatus: { $in: PAID },
      paidAt: { $type: "date" },
      fulfillmentStatus: "delivered",
      deliveredAt: { $type: "date" },
      cancelledAt: null,
    })
    .sort({ deliveredAt: 1, _id: 1 })
    .limit(1)
    .toArray();
  return order ?? null;
}

/** Whether the customer has a paid order for the product that's still on its way. */
async function hasOrderOnTheWay(userId: ObjectId, productId: ObjectId): Promise<boolean> {
  const order = await (await db()).orders.findOne(
    {
      buyerUserId: userId,
      "items.productId": productId,
      paidAt: { $type: "date" },
      cancelledAt: null,
      fulfillmentStatus: { $in: ["pending", "processing", "in_transit"] },
    },
    { projection: { _id: 1 } },
  );
  return order !== null;
}

async function eligibilityFor(userId: ObjectId, product: ProductDoc): Promise<ReviewEligibility> {
  if (product.sellerUserId.equals(userId)) return { state: "own_product" };
  const existing = await (await db()).reviews.findOne({ productId: product._id, reviewerUserId: userId });
  if (existing && existing.status !== "withdrawn") return { state: "reviewed", review: toMyReview(existing, product) };
  if (await qualifyingOrder(userId, product._id)) return { state: "eligible" };
  if (await hasOrderOnTheWay(userId, product._id)) return { state: "awaiting_delivery" };
  return { state: "not_purchased" };
}

// --- reading ----------------------------------------------------------------------------

/** Average, count and distribution over a product's published reviews only. */
export async function reviewSummary(productId: ObjectId): Promise<ReviewSummary> {
  const groups = await (await db()).reviews
    .aggregate<{ _id: number; count: number }>([
      { $match: { productId, status: "published" } },
      { $group: { _id: "$rating", count: { $sum: 1 } } },
    ])
    .toArray();
  const byRating = new Map(groups.map((g) => [g._id, g.count]));
  const distribution = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: byRating.get(stars) ?? 0 }));
  const count = distribution.reduce((total, d) => total + d.count, 0);
  const sum = distribution.reduce((total, d) => total + d.stars * d.count, 0);
  return { count, average: count === 0 ? null : Math.round((sum / count) * 10) / 10, distribution };
}

async function userNames(ids: ObjectId[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await (await db()).users
    .find({ _id: { $in: ids } })
    .project<Pick<UserDoc, "_id" | "fullName">>({ fullName: 1 })
    .toArray();
  return new Map(users.map((u) => [u._id.toHexString(), u.fullName]));
}

const pageOf = (page: number) => (Math.max(1, page) - 1) * REVIEW_LIMITS.pageSize;

/**
 * A listed product's published reviews (newest first), its rating summary
 * and what the viewer can do. null when the product isn't on the Market.
 */
export async function findProductReviews(viewerId: ObjectId, id: string, page: number) {
  const product = await listedProduct(id);
  if (!product) return null;
  const docs = await (await db()).reviews
    .find({ productId: product._id, status: "published" })
    .sort({ createdAt: -1, _id: -1 })
    .skip(pageOf(page))
    .limit(REVIEW_LIMITS.pageSize + 1)
    .toArray();
  const shown = docs.slice(0, REVIEW_LIMITS.pageSize);
  const [summary, names, viewer] = await Promise.all([
    reviewSummary(product._id),
    userNames(shown.map((d) => d.reviewerUserId)),
    eligibilityFor(viewerId, product),
  ]);
  return {
    summary,
    reviews: shown.map((d) => toPublicReview(d, names)),
    page: Math.max(1, page),
    hasMore: docs.length > REVIEW_LIMITS.pageSize,
    viewer,
  };
}

/** The signed-in user's own reviews, newest first, whatever their status. */
export async function listMyReviews(userId: ObjectId, page: number): Promise<{ reviews: MyReview[]; hasMore: boolean }> {
  const { reviews, products } = await db();
  const docs = await reviews
    .find({ reviewerUserId: userId })
    .sort({ createdAt: -1, _id: -1 })
    .skip(pageOf(page))
    .limit(REVIEW_LIMITS.pageSize + 1)
    .toArray();
  const shown = docs.slice(0, REVIEW_LIMITS.pageSize);
  const found = shown.length
    ? await products
        .find({ _id: { $in: shown.map((d) => d.productId) } })
        .project<Pick<ProductDoc, "_id" | "name" | "active" | "archivedAt">>({ name: 1, active: 1, archivedAt: 1 })
        .toArray()
    : [];
  const byId = new Map(found.map((p) => [p._id.toHexString(), p]));
  return {
    reviews: shown.map((d) => toMyReview(d, byId.get(d.productId.toHexString()) ?? null)),
    hasMore: docs.length > REVIEW_LIMITS.pageSize,
  };
}

// --- writing ----------------------------------------------------------------------------

/**
 * Brings the product's rating summary (used to filter and sort the Market)
 * in line with its published reviews. The review itself is already saved,
 * so a failure here is logged rather than reported to the customer; the
 * summary can be rebuilt with `npm run db:rebuild-search`.
 */
/** Recomputes a product's rating summary; a failure is logged (`npm run db:rebuild-search` repairs it). */
export async function refreshRating(productId: ObjectId) {
  try {
    await refreshProductRating(await getDb(), productId);
  } catch (error) {
    console.error(`[reviews] rating summary refresh failed: ${error instanceof Error ? error.name : typeof error}`);
  }
}

/** Writes the signed-in customer's review of a listed product they bought and received. */
export async function createReview(reviewer: UserDoc, productId: string, input: ReviewInput): Promise<MyReview> {
  const product = await listedProduct(productId);
  if (!product) throw new HttpError(404, PRODUCT_NOT_FOUND);
  if (product.sellerUserId.equals(reviewer._id)) throw new HttpError(403, "You can't review your own product.");

  const order = await qualifyingOrder(reviewer._id, product._id);
  if (!order) {
    throw new HttpError(
      403,
      (await hasOrderOnTheWay(reviewer._id, product._id))
        ? "You can review this product once your order has been delivered."
        : "Only customers who bought this product and received it can review it.",
    );
  }

  const now = new Date();
  const fields = {
    sellerUserId: product.sellerUserId,
    orderId: order._id,
    orderItemIndex: order.items.findIndex((item) => item.productId.equals(product._id)),
    rating: input.rating,
    text: input.text,
    status: NEW_REVIEW_STATUS,
    // set only here, from the order found above
    verifiedPurchase: true,
    editedAt: null,
    withdrawnAt: null,
    // the seller is told about a published review once it's stored
    notifySyncAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const { reviews } = await db();
  const notifySeller = (id: ObjectId) => queueNotifications("review notice", () => syncReviewNotification(id));
  try {
    const doc: ReviewDoc = { _id: new ObjectId(), productId: product._id, reviewerUserId: reviewer._id, ...fields };
    await reviews.insertOne(doc);
    await refreshRating(product._id);
    await notifySeller(doc._id);
    return toMyReview(doc, product);
  } catch (error) {
    if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
  }
  // The customer already has a review of this product. Only a withdrawn one
  // can be replaced, and only by one request (the status check is atomic).
  const replaced = await reviews.findOneAndUpdate(
    { productId: product._id, reviewerUserId: reviewer._id, status: "withdrawn" },
    { $set: fields },
    { returnDocument: "after" },
  );
  if (!replaced) throw new HttpError(409, ALREADY_REVIEWED);
  await refreshRating(product._id);
  await notifySeller(replaced._id);
  return toMyReview(replaced, product);
}

async function ownReview(reviewerUserId: ObjectId, id: string): Promise<ReviewDoc> {
  const _id = parseObjectId(id);
  // someone else's review behaves exactly like one that doesn't exist
  const doc = _id ? await (await db()).reviews.findOne({ _id, reviewerUserId }) : null;
  if (!doc) throw new HttpError(404, REVIEW_NOT_FOUND);
  return doc;
}

const CHANGED = "This review changed while you were editing it. Reload and try again.";

function refuseIfLocked(doc: ReviewDoc) {
  if (doc.status === "rejected") throw new HttpError(409, "This review was removed by moderation and can't be changed.");
  if (doc.status === "withdrawn")
    throw new HttpError(409, "You withdrew this review. You can write a new one from the product's page.");
}

async function productOf(doc: ReviewDoc) {
  return (await db()).products.findOne({ _id: doc.productId }, { projection: { name: 1, active: 1, archivedAt: 1 } });
}

/** Changes the rating and/or text of the author's own review. Its status and verification never change here. */
export async function updateReview(reviewerUserId: ObjectId, id: string, input: Partial<ReviewInput>): Promise<MyReview> {
  const doc = await ownReview(reviewerUserId, id);
  refuseIfLocked(doc);
  const unchanged = (input.rating ?? doc.rating) === doc.rating && (input.text ?? doc.text) === doc.text;
  if (unchanged) return toMyReview(doc, await productOf(doc));

  const now = new Date();
  const saved = await (await db()).reviews.findOneAndUpdate(
    { _id: doc._id, reviewerUserId, status: { $in: EDITABLE } },
    { $set: { ...input, editedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!saved) throw new HttpError(409, CHANGED);
  if (input.rating !== undefined) await refreshRating(saved.productId);
  return toMyReview(saved, await productOf(saved));
}

/** Takes the author's review down. Withdrawing twice is harmless. */
export async function withdrawReview(reviewerUserId: ObjectId, id: string): Promise<MyReview> {
  const doc = await ownReview(reviewerUserId, id);
  if (doc.status === "withdrawn") return toMyReview(doc, await productOf(doc));
  refuseIfLocked(doc);
  const now = new Date();
  const saved = await (await db()).reviews.findOneAndUpdate(
    { _id: doc._id, reviewerUserId, status: { $in: EDITABLE } },
    { $set: { status: "withdrawn", withdrawnAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!saved) throw new HttpError(409, CHANGED);
  await refreshRating(saved.productId);
  return toMyReview(saved, await productOf(saved));
}
