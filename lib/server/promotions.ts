import "server-only";
import { MongoServerError, ObjectId, type ClientSession } from "mongodb";
import { applyPromotion, isDiscount, type Discount, type NotApplicable, type PricingLine } from "@/lib/promotions/pricing";
import {
  normalizeCouponCode,
  PROMOTION_LIMITS,
  type OrderPromotion,
  type ProductOffer,
  type Promotion,
  type PromotionAction,
  type PromotionFields,
  type PromotionState,
  type PromotionStats,
  type PromotionStatus,
  type Quote,
} from "@/lib/promotions/types";
import {
  isPromotionType,
  validateCouponCode,
  validateOptionalKobo,
  validatePromotionDates,
  validatePromotionDescription,
  validatePromotionName,
  validatePromotionValue,
  validateUseLimit,
} from "@/lib/promotions/validation";
import { cleanText } from "@/lib/profile/validation";
import { formatKobo, isKobo } from "@/lib/wallet/money";
import { getDb } from "./db";
import { HttpError } from "./http";
import {
  COLLECTIONS,
  type OrderDoc,
  type OrderPromotionDoc,
  type ProductDoc,
  type PromotionDoc,
  type PromotionRedemptionDoc,
} from "./models";
import { parseObjectId } from "./products";

// Seller promotions: automatic sales and coupon codes on the seller's own
// products, paid for by that seller (the buyer simply pays less, so the
// seller's earning and the commission on it follow from the smaller payment;
// nothing else in the ledger changes).
//
// One promotion per order, never stacked: a code the buyer enters is the
// only one considered; without a code, the automatic sale that saves the
// most applies (the earliest created wins a tie). Prices and discounts are
// always worked out here from the database; the browser only sends product
// ids, quantities and the code.
//
// A use is reserved when the order is placed (in the same transaction, so
// the total and per-buyer limits hold under concurrency), redeemed when the
// order is paid and released if it is cancelled or expires unpaid.

export const PROMOTION_NOT_FOUND = "We couldn't find that promotion.";
export const PROMOTION_STALE = "This promotion changed since you opened it. Reload the page and try again.";
export const OFFER_CHANGED =
  "The offer on this order changed or ran out while you were ordering. Reload the page to see the current price.";
const UNKNOWN_CODE = "We don't recognise this code. Check it and try again.";
const MAX_LISTED = 100;

export async function promotionCollections() {
  const db = await getDb();
  return {
    promotions: db.collection<PromotionDoc>(COLLECTIONS.promotions),
    redemptions: db.collection<PromotionRedemptionDoc>(COLLECTIONS.promotionRedemptions),
    products: db.collection<ProductDoc>(COLLECTIONS.products),
  };
}

const lagosDate = (date: Date) =>
  new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" }).format(date);

/** Where a promotion stands now; only "live" ones reduce prices. */
export function promotionState(doc: PromotionDoc, now = new Date()): PromotionState {
  if (doc.status !== "active") return doc.status;
  if (now < doc.startsAt) return "scheduled";
  if (now >= doc.endsAt) return "expired";
  if (doc.totalLimit !== null && doc.redemptionCount >= doc.totalLimit) return "used_up";
  return "live";
}

// --- the seller's promotions --------------------------------------------------------------

type ParsedFields = Omit<PromotionFields, "productIds" | "startsAt" | "endsAt"> & {
  productIds: ObjectId[];
  startsAt: Date;
  endsAt: Date;
};

const FIELD_KEYS = [
  "name",
  "description",
  "type",
  "value",
  "scope",
  "productIds",
  "code",
  "startsAt",
  "endsAt",
  "minOrderKobo",
  "maxDiscountKobo",
  "totalLimit",
  "perBuyerLimit",
];

const optionalNumber = (value: unknown): number | null | undefined =>
  value === null || value === undefined ? null : typeof value === "number" ? value : undefined;

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== "string" || value.length > 40) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Every field of a promotion, checked. The seller and status never come
 * from the body; ownership of the products is checked separately against
 * the database (ownProducts).
 */
export function parsePromotionFields(body: Record<string, unknown>, allowed: string[] = []): ParsedFields {
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(body))
    if (!FIELD_KEYS.includes(key) && !allowed.includes(key)) fieldErrors[key] = "This field can't be set.";

  const name = typeof body.name === "string" ? cleanText(body.name) : "";
  const nameError = validatePromotionName(name);
  if (nameError) fieldErrors.name = nameError;
  const description = typeof body.description === "string" ? cleanText(body.description, true) : "";
  if (body.description !== undefined && typeof body.description !== "string") fieldErrors.description = "Enter text.";
  const descriptionError = validatePromotionDescription(description);
  if (descriptionError) fieldErrors.description = descriptionError;

  const { type, value } = body;
  if (!isPromotionType(type)) fieldErrors.type = "Choose a percentage or an amount off.";
  else {
    const valueError = typeof value === "number" ? validatePromotionValue(type, value) : "Enter how much to take off.";
    if (valueError) fieldErrors.value = valueError;
  }

  const productIds: ObjectId[] = [];
  const { scope } = body;
  if (scope !== "all" && scope !== "products") fieldErrors.scope = "Choose all your products or pick some.";
  else if (scope === "all") {
    if (body.productIds !== undefined && !(Array.isArray(body.productIds) && body.productIds.length === 0))
      fieldErrors.productIds = "Leave the product list empty for a promotion on all your products.";
  } else if (!Array.isArray(body.productIds) || body.productIds.length === 0)
    fieldErrors.productIds = "Choose at least one of your products.";
  else if (body.productIds.length > PROMOTION_LIMITS.products.max)
    fieldErrors.productIds = `Choose up to ${PROMOTION_LIMITS.products.max} products, or apply it to all of them.`;
  else {
    const seen = new Set<string>();
    for (const raw of body.productIds) {
      const id = parseObjectId(raw);
      if (!id || seen.has(id.toHexString())) {
        fieldErrors.productIds = "One of the products isn't valid. Reload the page and try again.";
        break;
      }
      seen.add(id.toHexString());
      productIds.push(id);
    }
  }

  let code: string | null = null;
  if (body.code !== undefined && body.code !== null) {
    if (typeof body.code !== "string") fieldErrors.code = "Enter a code, or leave it empty.";
    else {
      const codeError = validateCouponCode(body.code);
      if (codeError) fieldErrors.code = codeError;
      code = normalizeCouponCode(body.code) || null;
    }
  }

  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  Object.assign(fieldErrors, validatePromotionDates(startsAt, endsAt));

  const minOrderKobo = optionalNumber(body.minOrderKobo);
  const maxDiscountKobo = optionalNumber(body.maxDiscountKobo);
  const totalLimit = optionalNumber(body.totalLimit);
  const perBuyerLimit = optionalNumber(body.perBuyerLimit);
  const minError = minOrderKobo === undefined ? "Enter an amount." : validateOptionalKobo(minOrderKobo, "a minimum");
  if (minError) fieldErrors.minOrderKobo = minError;
  const capError = maxDiscountKobo === undefined ? "Enter an amount." : validateOptionalKobo(maxDiscountKobo, "a cap");
  if (capError) fieldErrors.maxDiscountKobo = capError;
  else if (type === "fixed" && maxDiscountKobo !== null)
    fieldErrors.maxDiscountKobo = "A cap only applies to percentage offers. Leave it empty.";
  const totalError =
    totalLimit === undefined ? "Enter a number." : validateUseLimit(totalLimit, PROMOTION_LIMITS.totalLimit.max);
  if (totalError) fieldErrors.totalLimit = totalError;
  const buyerError =
    perBuyerLimit === undefined ? "Enter a number." : validateUseLimit(perBuyerLimit, PROMOTION_LIMITS.perBuyerLimit.max);
  if (buyerError) fieldErrors.perBuyerLimit = buyerError;
  else if (typeof totalLimit === "number" && typeof perBuyerLimit === "number" && perBuyerLimit > totalLimit)
    fieldErrors.perBuyerLimit = "This can't be more than the total number of uses.";

  if (Object.keys(fieldErrors).length)
    throw new HttpError(400, "Some details aren't valid. Check the highlighted fields.", fieldErrors);
  return {
    name,
    description,
    type: type as PromotionDoc["type"],
    value: value as number,
    scope: scope as PromotionDoc["scope"],
    productIds,
    code,
    startsAt: startsAt!,
    endsAt: endsAt!,
    minOrderKobo: minOrderKobo!,
    maxDiscountKobo: maxDiscountKobo!,
    totalLimit: totalLimit!,
    perBuyerLimit: perBuyerLimit!,
  };
}

export function parseExpectedVersion(body: Record<string, unknown>): number {
  const { expectedVersion } = body;
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new HttpError(400, PROMOTION_STALE, { expectedVersion: "Reload the page and try again." });
  return expectedVersion;
}

/** Refuses product ids that aren't the seller's own current listings. */
async function checkOwnProducts(sellerUserId: ObjectId, ids: ObjectId[]) {
  if (ids.length === 0) return;
  const { products } = await promotionCollections();
  const owned = await products.countDocuments({ _id: { $in: ids }, sellerUserId, archivedAt: null });
  if (owned !== ids.length)
    throw new HttpError(400, "Choose from your own current listings.", {
      productIds: "One of these products isn't one of your current listings.",
    });
}

const codeTaken = (error: unknown) =>
  error instanceof MongoServerError && error.code === 11000 && JSON.stringify(error.keyPattern ?? {}).includes("code");

const CODE_TAKEN = new HttpError(409, "That code is already in use. Choose another.", {
  code: "That code is already in use. Choose another.",
});

export async function createPromotion(sellerUserId: ObjectId, fields: ParsedFields): Promise<PromotionDoc> {
  await checkOwnProducts(sellerUserId, fields.productIds);
  const { promotions } = await promotionCollections();
  const now = new Date();
  const doc: PromotionDoc = {
    _id: new ObjectId(),
    sellerUserId,
    ...fields,
    // always starts as a draft: the seller checks the preview, then activates
    status: "draft",
    version: 1,
    redemptionCount: 0,
    history: [{ event: "created", at: now }],
    createdAt: now,
    updatedAt: now,
  };
  try {
    await promotions.insertOne(doc);
  } catch (error) {
    if (codeTaken(error)) throw CODE_TAKEN;
    throw error;
  }
  return doc;
}

export async function findOwnPromotion(sellerUserId: ObjectId, id: string): Promise<PromotionDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  return (await promotionCollections()).promotions.findOne({ _id, sellerUserId });
}

/** Why a conditional change found nothing: missing, stale, or not allowed in this status. */
async function refusal(sellerUserId: ObjectId, id: ObjectId, expectedVersion: number, statusMessage: string) {
  const { promotions } = await promotionCollections();
  const current = await promotions.findOne({ _id: id, sellerUserId });
  if (!current) return new HttpError(404, PROMOTION_NOT_FOUND);
  if (current.version !== expectedVersion) return new HttpError(409, PROMOTION_STALE);
  return new HttpError(409, statusMessage);
}

/**
 * Edits a draft or paused promotion. A live one has to be paused first, so
 * buyers never meet terms that change between the quote and the order.
 * Orders already placed keep the terms they were priced with.
 */
export async function updatePromotion(
  sellerUserId: ObjectId,
  id: string,
  fields: ParsedFields,
  expectedVersion: number,
): Promise<PromotionDoc> {
  const _id = parseObjectId(id);
  if (!_id) throw new HttpError(404, PROMOTION_NOT_FOUND);
  await checkOwnProducts(sellerUserId, fields.productIds);
  const { promotions } = await promotionCollections();
  const now = new Date();
  let saved: PromotionDoc | null;
  try {
    saved = await promotions.findOneAndUpdate(
      { _id, sellerUserId, version: expectedVersion, status: { $in: ["draft", "paused"] } },
      { $set: { ...fields, updatedAt: now }, $inc: { version: 1 }, $push: { history: { event: "edited", at: now } } },
      { returnDocument: "after" },
    );
  } catch (error) {
    if (codeTaken(error)) throw CODE_TAKEN;
    throw error;
  }
  if (!saved)
    throw await refusal(sellerUserId, _id, expectedVersion, "Pause this promotion before editing it. Ended promotions can't be edited.");
  return saved;
}

const TRANSITIONS: Record<PromotionAction, { from: PromotionStatus[]; to: PromotionStatus; event: "activated" | "paused" | "ended" }> = {
  activate: { from: ["draft", "paused"], to: "active", event: "activated" },
  pause: { from: ["active"], to: "paused", event: "paused" },
  end: { from: ["draft", "active", "paused"], to: "ended", event: "ended" },
};

export function isPromotionAction(value: unknown): value is PromotionAction {
  return value === "activate" || value === "pause" || value === "end";
}

/** Activates, pauses or ends one of the seller's promotions. Ending is final. */
export async function changePromotionStatus(
  sellerUserId: ObjectId,
  id: string,
  action: PromotionAction,
  expectedVersion: number,
): Promise<PromotionDoc> {
  const _id = parseObjectId(id);
  if (!_id) throw new HttpError(404, PROMOTION_NOT_FOUND);
  const { promotions } = await promotionCollections();
  const now = new Date();
  const { from, to, event } = TRANSITIONS[action];
  const filter: Record<string, unknown> = { _id, sellerUserId, version: expectedVersion, status: { $in: from } };

  if (action === "activate") {
    const current = await promotions.findOne({ _id, sellerUserId });
    if (!current) throw new HttpError(404, PROMOTION_NOT_FOUND);
    if (current.endsAt <= now) throw new HttpError(409, "This promotion's end time has passed. Edit the dates first.");
    if (current.scope === "products") {
      const { products } = await promotionCollections();
      const listed = await products.countDocuments({ _id: { $in: current.productIds }, sellerUserId, archivedAt: null });
      if (listed === 0)
        throw new HttpError(409, "None of this promotion's products are listed any more. Edit the products first.");
    }
    filter.endsAt = { $gt: now };
  }

  const saved = await promotions.findOneAndUpdate(
    filter,
    { $set: { status: to, updatedAt: now }, $inc: { version: 1 }, $push: { history: { event, at: now } } },
    { returnDocument: "after" },
  );
  if (!saved) {
    const message =
      action === "activate"
        ? "Only draft or paused promotions can be activated."
        : action === "pause"
          ? "Only active promotions can be paused."
          : "This promotion has already ended.";
    throw await refusal(sellerUserId, _id, expectedVersion, message);
  }
  return saved;
}

/** Results per promotion, from its redemptions (released ones don't count). */
async function statsFor(ids: ObjectId[]): Promise<Map<string, PromotionStats>> {
  const stats = new Map<string, PromotionStats>();
  if (ids.length === 0) return stats;
  const { redemptions } = await promotionCollections();
  const rows = await redemptions
    .aggregate<{ _id: { promotionId: ObjectId; status: string }; count: number; discountKobo: number; paidKobo: number }>([
      { $match: { promotionId: { $in: ids }, status: { $in: ["reserved", "redeemed"] } } },
      {
        $group: {
          _id: { promotionId: "$promotionId", status: "$status" },
          count: { $sum: 1 },
          discountKobo: { $sum: "$discountKobo" },
          paidKobo: { $sum: "$totalKobo" },
        },
      },
    ])
    .toArray();
  for (const row of rows) {
    const key = row._id.promotionId.toHexString();
    const s = stats.get(key) ?? { redeemedCount: 0, reservedCount: 0, discountKobo: 0, paidKobo: 0 };
    if (row._id.status === "redeemed") {
      s.redeemedCount = row.count;
      s.discountKobo = row.discountKobo;
      s.paidKobo = row.paidKobo;
    } else s.reservedCount = row.count;
    stats.set(key, s);
  }
  return stats;
}

async function productNames(docs: PromotionDoc[]): Promise<Map<string, string>> {
  const ids = [...new Map(docs.flatMap((d) => d.productIds).map((id) => [id.toHexString(), id])).values()];
  if (ids.length === 0) return new Map();
  const { products } = await promotionCollections();
  const found = await products.find({ _id: { $in: ids } }).project<Pick<ProductDoc, "_id" | "name">>({ name: 1 }).toArray();
  return new Map(found.map((p) => [p._id.toHexString(), p.name]));
}

export function toPromotion(
  doc: PromotionDoc,
  names: Map<string, string>,
  stats: PromotionStats | undefined,
  now = new Date(),
): Promotion {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    description: doc.description,
    type: doc.type,
    value: doc.value,
    scope: doc.scope,
    productIds: doc.productIds.map((id) => id.toHexString()),
    products: doc.productIds.map((id) => ({ id: id.toHexString(), name: names.get(id.toHexString()) ?? "Removed listing" })),
    code: doc.code,
    startsAt: doc.startsAt.toISOString(),
    endsAt: doc.endsAt.toISOString(),
    minOrderKobo: doc.minOrderKobo,
    maxDiscountKobo: doc.maxDiscountKobo,
    totalLimit: doc.totalLimit,
    perBuyerLimit: doc.perBuyerLimit,
    status: doc.status,
    state: promotionState(doc, now),
    version: doc.version,
    redemptionCount: doc.redemptionCount,
    stats: stats ?? { redeemedCount: 0, reservedCount: 0, discountKobo: 0, paidKobo: 0 },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Public views of promotions, with product names and results. */
export async function toPromotions(docs: PromotionDoc[]): Promise<Promotion[]> {
  const [names, stats] = await Promise.all([productNames(docs), statsFor(docs.map((d) => d._id))]);
  const now = new Date();
  return docs.map((d) => toPromotion(d, names, stats.get(d._id.toHexString()), now));
}

export async function listOwnPromotions(sellerUserId: ObjectId): Promise<Promotion[]> {
  const { promotions } = await promotionCollections();
  const docs = await promotions.find({ sellerUserId }).sort({ createdAt: -1, _id: -1 }).limit(MAX_LISTED).toArray();
  return toPromotions(docs);
}

// --- pricing an order ----------------------------------------------------------------------

export type PricedPromotion = { promotion: PromotionDoc; discount: Discount };

/** Unpaid and paid orders holding or using one of these promotions, per promotion, for this buyer. */
async function buyerUses(buyerUserId: ObjectId, ids: ObjectId[], session?: ClientSession): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { redemptions } = await promotionCollections();
  const rows = await redemptions
    .aggregate<{ _id: ObjectId; count: number }>(
      [
        { $match: { promotionId: { $in: ids }, buyerUserId, status: { $in: ["reserved", "redeemed"] } } },
        { $group: { _id: "$promotionId", count: { $sum: 1 } } },
      ],
      { session },
    )
    .toArray();
  return new Map(rows.map((r) => [r._id.toHexString(), r.count]));
}

const ruleOf = (p: PromotionDoc) => ({
  type: p.type,
  value: p.value,
  scope: p.scope,
  productIds: p.productIds.map((id) => id.toHexString()),
  minOrderKobo: p.minOrderKobo,
  maxDiscountKobo: p.maxDiscountKobo,
});

function notApplicableMessage(result: NotApplicable): string {
  switch (result.reason) {
    case "no_eligible_items":
      return "This code doesn't cover the products in your order.";
    case "below_minimum":
      return `Spend at least ${formatKobo(result.minOrderKobo)} on the products this code covers to use it.`;
    case "no_saving":
      return "This code doesn't reduce this order's total.";
  }
}

/**
 * The one promotion for an order from `sellerUserId` made of `lines`: the
 * entered code (and nothing else), or else the best live automatic sale.
 * `couponError` explains a code that can't be used.
 */
export async function choosePromotion(
  buyerUserId: ObjectId,
  sellerUserId: ObjectId,
  lines: PricingLine[],
  couponCode: string | null,
  now = new Date(),
): Promise<{ priced: PricedPromotion | null; couponError: string | null }> {
  const { promotions } = await promotionCollections();

  if (couponCode) {
    const promotion = await promotions.findOne({ code: couponCode });
    // another seller's code, a draft or a typo all look the same to the buyer
    if (!promotion || !promotion.sellerUserId.equals(sellerUserId) || promotion.status === "draft")
      return { priced: null, couponError: UNKNOWN_CODE };
    const state = promotionState(promotion, now);
    const stateError: Partial<Record<PromotionState, string>> = {
      ended: "This code has ended.",
      paused: "The seller has paused this code for now.",
      scheduled: `This code can be used from ${lagosDate(promotion.startsAt)}.`,
      expired: "This code has expired.",
      used_up: "This code has been fully used.",
    };
    if (state !== "live") return { priced: null, couponError: stateError[state] ?? UNKNOWN_CODE };
    if (promotion.perBuyerLimit !== null) {
      const used = (await buyerUses(buyerUserId, [promotion._id])).get(promotion._id.toHexString()) ?? 0;
      if (used >= promotion.perBuyerLimit)
        return { priced: null, couponError: "You've already used this code as many times as it allows." };
    }
    const result = applyPromotion(ruleOf(promotion), lines);
    if (!isDiscount(result)) return { priced: null, couponError: notApplicableMessage(result) };
    return { priced: { promotion, discount: result }, couponError: null };
  }

  const live = (
    await promotions
      .find({ sellerUserId, status: "active", code: null, startsAt: { $lte: now }, endsAt: { $gt: now } })
      .toArray()
  ).filter((p) => promotionState(p, now) === "live");
  const limited = live.filter((p) => p.perBuyerLimit !== null).map((p) => p._id);
  const uses = await buyerUses(buyerUserId, limited);
  let best: PricedPromotion | null = null;
  for (const promotion of live) {
    if (promotion.perBuyerLimit !== null && (uses.get(promotion._id.toHexString()) ?? 0) >= promotion.perBuyerLimit) continue;
    const result = applyPromotion(ruleOf(promotion), lines);
    if (!isDiscount(result)) continue;
    const better =
      !best ||
      result.discountKobo > best.discount.discountKobo ||
      (result.discountKobo === best.discount.discountKobo &&
        (promotion.createdAt < best.promotion.createdAt ||
          (promotion.createdAt.getTime() === best.promotion.createdAt.getTime() &&
            promotion._id.toHexString() < best.promotion._id.toHexString())));
    if (better) best = { promotion, discount: result };
  }
  return { priced: best, couponError: null };
}

/** The order's copy of the promotion it used. */
export function orderPromotionSnapshot({ promotion: p, discount }: PricedPromotion): OrderPromotionDoc {
  return {
    promotionId: p._id,
    version: p.version,
    name: p.name,
    code: p.code,
    type: p.type,
    value: p.value,
    scope: p.scope,
    productIds: p.productIds,
    minOrderKobo: p.minOrderKobo,
    maxDiscountKobo: p.maxDiscountKobo,
    eligibleSubtotalKobo: discount.eligibleSubtotalKobo,
    discountKobo: discount.discountKobo,
  };
}

export function toOrderPromotion(p: OrderPromotionDoc): OrderPromotion {
  return {
    name: p.name,
    code: p.code,
    type: p.type,
    value: p.value,
    eligibleSubtotalKobo: p.eligibleSubtotalKobo,
    discountKobo: p.discountKobo,
  };
}

/**
 * Takes one use of the promotion for a new order, inside the transaction
 * that creates it. The conditional increment fails if the promotion was
 * paused, edited, ended, ran out or expired after the order was priced, and
 * because every use writes the promotion, concurrent orders conflict and
 * are retried one after another, so the limits can't be overshot.
 */
export async function reserveRedemption(session: ClientSession, order: OrderDoc, now: Date) {
  const snapshot = order.promotion;
  if (!snapshot) return;
  const { promotions, redemptions } = await promotionCollections();
  const current = await promotions.findOne({ _id: snapshot.promotionId }, { session });
  const claimed = await promotions.updateOne(
    {
      _id: snapshot.promotionId,
      sellerUserId: order.sellerUserId,
      status: "active",
      version: snapshot.version,
      startsAt: { $lte: now },
      endsAt: { $gt: now },
      ...(current?.totalLimit != null ? { redemptionCount: { $lt: current.totalLimit } } : {}),
    },
    { $inc: { redemptionCount: 1 } },
    { session },
  );
  if (claimed.modifiedCount !== 1 || !current) throw new HttpError(409, OFFER_CHANGED, offerField(snapshot));
  if (current.perBuyerLimit !== null) {
    const used = (await buyerUses(order.buyerUserId, [current._id], session)).get(current._id.toHexString()) ?? 0;
    if (used >= current.perBuyerLimit) throw new HttpError(409, OFFER_CHANGED, offerField(snapshot));
  }
  await redemptions.insertOne(
    {
      _id: new ObjectId(),
      promotionId: snapshot.promotionId,
      sellerUserId: order.sellerUserId,
      buyerUserId: order.buyerUserId,
      orderId: order._id,
      orderNumber: order.number,
      status: "reserved",
      discountKobo: snapshot.discountKobo,
      eligibleSubtotalKobo: snapshot.eligibleSubtotalKobo,
      totalKobo: order.totalKobo,
      reservedAt: now,
      redeemedAt: null,
      releasedAt: null,
    },
    { session },
  );
}

const offerField = (snapshot: OrderPromotionDoc) => (snapshot.code ? { couponCode: OFFER_CHANGED } : undefined);

/** The order was paid: its reserved use becomes a redemption (in the payment's transaction). */
export async function redeemForOrder(session: ClientSession, orderId: ObjectId, now: Date) {
  const { redemptions } = await promotionCollections();
  await redemptions.updateOne({ orderId, status: "reserved" }, { $set: { status: "redeemed", redeemedAt: now } }, { session });
}

/**
 * The order was cancelled (or expired unpaid): its use is given back, once,
 * in the same transaction that returns its stock.
 */
export async function releaseForOrder(session: ClientSession, order: OrderDoc, now: Date) {
  if (!order.promotion) return;
  const { promotions, redemptions } = await promotionCollections();
  const released = await redemptions.updateOne(
    { orderId: order._id, status: { $in: ["reserved", "redeemed"] } },
    { $set: { status: "released", releasedAt: now } },
    { session },
  );
  if (released.modifiedCount === 1)
    await promotions.updateOne(
      { _id: order.promotion.promotionId, redemptionCount: { $gt: 0 } },
      { $inc: { redemptionCount: -1 } },
      { session },
    );
}

/**
 * Whether the order's amounts add up: lines to the subtotal, line discounts
 * to the discount, and subtotal less discount to the total. Checked before
 * any payment is started for it.
 */
export function pricingConsistent(order: OrderDoc): boolean {
  const lines = order.items.reduce((sum, i) => sum + i.lineTotalKobo, 0);
  const lineDiscounts = order.items.reduce((sum, i) => sum + (i.discountKobo ?? 0), 0);
  const discount = order.promotion?.discountKobo ?? 0;
  return (
    isKobo(order.totalKobo) &&
    order.totalKobo > 0 &&
    lines === order.subtotalKobo &&
    lineDiscounts === discount &&
    order.items.every((i) => (i.discountKobo ?? 0) >= 0 && (i.discountKobo ?? 0) <= i.lineTotalKobo) &&
    order.subtotalKobo - discount === order.totalKobo
  );
}

// --- the Market and the quote --------------------------------------------------------------

/**
 * The live automatic sale to show on each listing (no codes are ever
 * shown). The Market only hints at the offer; the order is always priced
 * again at checkout.
 */
export async function marketOffers(
  docs: Array<Pick<ProductDoc, "_id" | "sellerUserId" | "priceKobo">>,
  now = new Date(),
): Promise<Map<string, ProductOffer>> {
  const offers = new Map<string, ProductOffer>();
  if (docs.length === 0) return offers;
  const sellers = [...new Map(docs.map((d) => [d.sellerUserId.toHexString(), d.sellerUserId])).values()];
  const { promotions } = await promotionCollections();
  const live = (
    await promotions
      .find({ sellerUserId: { $in: sellers }, status: "active", code: null, startsAt: { $lte: now }, endsAt: { $gt: now } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray()
  ).filter((p) => promotionState(p, now) === "live");
  if (live.length === 0) return offers;

  for (const product of docs) {
    const id = product._id.toHexString();
    let best: { p: PromotionDoc; saving: number } | null = null;
    for (const p of live) {
      if (!p.sellerUserId.equals(product.sellerUserId)) continue;
      if (p.scope === "products" && !p.productIds.some((pid) => pid.equals(product._id))) continue;
      const result = applyPromotion(ruleOf(p), [{ productId: id, lineTotalKobo: product.priceKobo }]);
      const saving = isDiscount(result) ? result.discountKobo : 0;
      if (!best || saving > best.saving) best = { p, saving };
    }
    if (!best) continue;
    const { p, saving } = best;
    offers.set(id, {
      name: p.name,
      type: p.type,
      value: p.value,
      salePriceKobo: p.type === "percentage" && p.minOrderKobo === null && saving > 0 ? product.priceKobo - saving : null,
      minOrderKobo: p.minOrderKobo,
      maxDiscountKobo: p.maxDiscountKobo,
      endsAt: p.endsAt.toISOString(),
    });
  }
  return offers;
}

/**
 * What an order would cost now, with the buyer's code if they entered one.
 * Reserves nothing: placing the order prices it again.
 */
export async function quoteOrder(
  buyerUserId: ObjectId,
  items: Array<{ productId: ObjectId; quantity: number }>,
  couponCode: string | null,
): Promise<Quote> {
  const { products } = await promotionCollections();
  const docs = await products
    .find({ _id: { $in: items.map((i) => i.productId) }, active: true, archivedAt: null })
    .project<Pick<ProductDoc, "_id" | "sellerUserId" | "priceKobo">>({ sellerUserId: 1, priceKobo: 1 })
    .toArray();
  const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
  const lines: PricingLine[] = [];
  for (const { productId, quantity } of items) {
    const product = byId.get(productId.toHexString());
    if (!product) throw new HttpError(409, "A product in your order is no longer available. Reload and try again.");
    if (product.sellerUserId.equals(buyerUserId)) throw new HttpError(400, "You can't order your own product.");
    if (!product.sellerUserId.equals(docs[0].sellerUserId))
      throw new HttpError(400, "An order can only contain products from one seller. Place a separate order for each.");
    lines.push({ productId: productId.toHexString(), lineTotalKobo: product.priceKobo * quantity });
  }
  const subtotalKobo = lines.reduce((sum, l) => sum + l.lineTotalKobo, 0);
  if (!isKobo(subtotalKobo)) throw new HttpError(400, "This order is larger than we can take. Reduce the quantity.");
  const { priced, couponError } = await choosePromotion(buyerUserId, docs[0].sellerUserId, lines, couponCode);
  const discountKobo = priced?.discount.discountKobo ?? 0;
  return {
    subtotalKobo,
    discountKobo,
    totalKobo: subtotalKobo - discountKobo,
    promotion: priced ? toOrderPromotion(orderPromotionSnapshot(priced)) : null,
    couponError,
  };
}
