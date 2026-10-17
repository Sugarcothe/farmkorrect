import "server-only";
import { ObjectId } from "mongodb";
import {
  ADMIN_PAGE_SIZE,
  isModerationAction,
  MODERATION_TRANSITIONS,
  type ModerationAction,
  type ModerationCase,
  type ModerationPage,
  type ModerationStatus,
} from "@/lib/admin/types";
import { validateAdminReason } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";
import { recordAudit } from "./admin-audit";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type ProductDoc, type ReviewDoc, type UserDoc } from "./models";
import { queueNotifications, syncReviewNotification } from "./notifications";
import { inTransaction } from "./order-store";
import { refreshRating, REVIEW_NOT_FOUND } from "./reviews";

// Review moderation. Only the moves in MODERATION_TRANSITIONS are possible;
// each one changes the status (never the rating or text) of the exact
// version of the review the admin looked at, commits with its audit record,
// then refreshes the product's rating summary and tells the author. Reviews
// are never deleted, and withdrawn ones (the author's own choice) are left
// alone. An admin can't moderate reviews of their own products or their own
// reviews. The reason is internal: it's kept in the audit trail only.

async function collections() {
  const db = await getDb();
  return {
    reviews: db.collection<ReviewDoc>(COLLECTIONS.reviews),
    products: db.collection<ProductDoc>(COLLECTIONS.products),
    users: db.collection<UserDoc>(COLLECTIONS.users),
  };
}

async function toCases(docs: ReviewDoc[], viewer: ObjectId): Promise<ModerationCase[]> {
  const { products, users } = await collections();
  const productIds = [...new Map(docs.map((d) => [d.productId.toHexString(), d.productId])).values()];
  const userIds = [...new Map(docs.map((d) => [d.reviewerUserId.toHexString(), d.reviewerUserId])).values()];
  const [productDocs, userDocs] = await Promise.all([
    products.find({ _id: { $in: productIds } }, { projection: { name: 1 } }).toArray(),
    users.find({ _id: { $in: userIds } }, { projection: { fullName: 1 } }).toArray(),
  ]);
  const productNames = new Map(productDocs.map((p) => [p._id.toHexString(), p.name]));
  const userNames = new Map(userDocs.map((u) => [u._id.toHexString(), u.fullName]));
  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    productId: doc.productId.toHexString(),
    productName: productNames.get(doc.productId.toHexString()) ?? "A removed product",
    reviewerName: userNames.get(doc.reviewerUserId.toHexString()) ?? "A removed account",
    rating: doc.rating,
    text: doc.text,
    status: doc.status,
    verifiedPurchase: doc.verifiedPurchase,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    conflict: doc.sellerUserId.equals(viewer) || doc.reviewerUserId.equals(viewer),
  }));
}

export const MODERATION_STATUSES: readonly ModerationStatus[] = ["pending", "published", "rejected"];

export const isModerationStatus = (value: unknown): value is ModerationStatus =>
  typeof value === "string" && (MODERATION_STATUSES as readonly string[]).includes(value);

/** Reviews in one status, newest first (pending is the queue), as `viewer` (an admin) sees them. */
export async function listReviewsForModeration(
  viewer: ObjectId,
  status: ModerationStatus,
  page: number,
  pageSize = ADMIN_PAGE_SIZE,
): Promise<ModerationPage> {
  const { reviews } = await collections();
  const docs = await reviews
    .find({ status })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  return { cases: await toCases(docs.slice(0, pageSize), viewer), page, hasMore: docs.length > pageSize };
}

export async function countPendingReviews(): Promise<number> {
  return (await collections()).reviews.countDocuments({ status: "pending" });
}

export type ParsedModeration = { action: ModerationAction; reason: string | null; updatedAt: Date };

export function parseModeration(body: Record<string, unknown>): ParsedModeration {
  const fieldErrors: Record<string, string> = {};
  const unknown = Object.keys(body).filter((k) => !["action", "reason", "updatedAt"].includes(k));
  if (unknown.length) fieldErrors[unknown[0]] = "This field can't be sent.";
  const action = body.action;
  if (!isModerationAction(action)) fieldErrors.action = "Choose what to do with this review.";
  const rawReason = body.reason;
  if (rawReason !== undefined && typeof rawReason !== "string") fieldErrors.reason = "Give a reason.";
  const reason = typeof rawReason === "string" ? cleanText(rawReason, true) : "";
  if ((isModerationAction(action) && MODERATION_TRANSITIONS[action].reason) || reason) {
    const error = validateAdminReason(reason);
    if (error) fieldErrors.reason = error;
  }
  const updatedAt = typeof body.updatedAt === "string" ? new Date(body.updatedAt) : null;
  if (!updatedAt || Number.isNaN(updatedAt.getTime())) fieldErrors.updatedAt = "Reload the page and try again.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please correct the highlighted fields.", fieldErrors);
  return { action: action as ModerationAction, reason: reason || null, updatedAt: updatedAt! };
}

const STALE = "This review changed since you opened it. Reload to see its current state.";

export async function moderateReview(admin: UserDoc, id: string, input: ParsedModeration): Promise<ModerationCase> {
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new HttpError(404, REVIEW_NOT_FOUND);
  const { reviews } = await collections();
  const current = await reviews.findOne({ _id: new ObjectId(id) });
  if (!current) throw new HttpError(404, REVIEW_NOT_FOUND);
  if (current.sellerUserId.equals(admin._id))
    throw new HttpError(403, "You can't moderate reviews of your own products.");
  if (current.reviewerUserId.equals(admin._id)) throw new HttpError(403, "You can't moderate your own review.");
  const { from, to } = MODERATION_TRANSITIONS[input.action];
  if (current.status !== from || current.updatedAt.getTime() !== input.updatedAt.getTime())
    throw new HttpError(409, STALE);

  const saved = await inTransaction(async (session) => {
    const now = new Date();
    const review = await reviews.findOneAndUpdate(
      { _id: current._id, status: from, updatedAt: input.updatedAt },
      { $set: { status: to, moderation: { action: input.action, at: now }, notifySyncAt: now, updatedAt: now } },
      { returnDocument: "after", session },
    );
    if (!review) return null;
    await recordAudit(
      {
        actorUserId: admin._id,
        action: `review.${input.action}` as const,
        target: { type: "review", id: review._id.toHexString() },
        reason: input.reason,
        from,
        to,
      },
      session,
      now,
    );
    return review;
  });
  if (!saved) throw new HttpError(409, STALE);
  await refreshRating(saved.productId);
  await queueNotifications("review notifications", () => syncReviewNotification(saved._id));
  const [shown] = await toCases([saved], admin._id);
  return shown;
}
