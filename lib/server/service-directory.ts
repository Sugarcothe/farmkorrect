import "server-only";
import { ObjectId, type Document, type Filter } from "mongodb";
import { ROLE_LABELS, ROLES } from "@/lib/auth/types";
import { MARKETPLACE_CATEGORIES, MARKETPLACE_ROLES, marketplaceLabel, SERVICE_LIMITS } from "@/lib/services/config";
import {
  canonicalServiceQuery,
  type MarketplaceServiceDetails,
  type ServiceCard,
  type ServiceDirectoryPage,
  type ServiceDirectoryQuery,
  type ServiceProviderProfile,
  type ServiceProviderSummary,
} from "@/lib/services/marketplace";
import { getAuthConfig } from "./config";
import { hmac, safeEqualHex } from "./crypto";
import { HttpError } from "./http";
import type { ServiceDoc, UserDoc } from "./models";
import { bookingCollections } from "./service-booking-store";
import { isListedService } from "./service-bookings";
import { parseId } from "./vet-directory";

// The Other Services directory (docs/other-services.md): marketplace
// services anyone can book, read straight from the services collection
// with each owner's account joined in, so a provider whose account isn't
// active, or whose role may not offer a category, never appears. Newest
// first, keyset paged on (createdAt, _id) with a signed cursor bound to the
// filters it was made for. There are no ratings, job counts, distances or
// ETAs: nothing records them.

export const SERVICE_DIRECTORY_UNVERIFIED = "Verify your phone number before browsing services.";
export const MARKETPLACE_SERVICE_NOT_FOUND = "We couldn't find that service. It may not be taking bookings right now.";
export const BAD_SERVICE_CURSOR = "This list has changed. Start the search again.";

const OWNER_PROJECTION = { _id: 1, fullName: 1, role: 1, status: 1, profile: 1 } as const;
type Owner = Pick<UserDoc, "_id" | "fullName" | "role" | "status" | "profile">;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Listed marketplace services, as far as the services collection alone can tell. */
const LISTED: Filter<ServiceDoc> = {
  active: true,
  bookingAvailable: true,
  archivedAt: null,
  pricing: { $type: "string" },
  category: { $in: MARKETPLACE_CATEGORIES.map((c) => c.value) },
  $or: [{ pricing: "quote" }, { pricing: "fixed", priceNgn: { $gt: 0 } }],
};

/** The owner's account is active and their role may offer the service's category. */
const OWNER_ALLOWED: Document = {
  "owner.status": "active",
  $or: ROLES.filter((role) => MARKETPLACE_ROLES[role].length > 0).map((role) => ({
    "owner.role": role,
    category: { $in: [...MARKETPLACE_ROLES[role]] },
  })),
};

export function serviceDirectoryFilter(query: ServiceDirectoryQuery): Filter<ServiceDoc> {
  const filter: Filter<ServiceDoc> = { ...LISTED };
  if (query.category) filter.category = query.category;
  if (query.state) filter.serviceStates = query.state;
  if (query.pricing === "quote") filter.pricing = "quote";
  if (query.pricing === "fixed") {
    filter.pricing = "fixed";
    filter.priceNgn = query.maxPrice !== null ? { $gt: 0, $lte: query.maxPrice } : { $gt: 0 };
  }
  if (query.q) filter.searchWords = { $all: query.q.split(" ").map((w) => new RegExp(`^${escapeRegex(w)}`)) };
  return filter;
}

// --- the cursor ------------------------------------------------------------------------

function cursorSignature(query: ServiceDirectoryQuery, payload: string) {
  return hmac(getAuthConfig().secret, "service-directory-cursor", canonicalServiceQuery(query), payload).slice(0, 32);
}

export function encodeServiceCursor(query: ServiceDirectoryQuery, doc: Pick<ServiceDoc, "_id" | "createdAt">) {
  const payload = Buffer.from(JSON.stringify({ v: 1, t: doc.createdAt.getTime(), i: doc._id.toHexString() })).toString(
    "base64url",
  );
  return `${payload}.${cursorSignature(query, payload)}`;
}

/** Only accepted with the exact filters it was made for (the signature covers them). */
export function decodeServiceCursor(query: ServiceDirectoryQuery, cursor: string): { at: Date; id: ObjectId } {
  const bad = () => new HttpError(400, BAD_SERVICE_CURSOR);
  if (cursor.length > 300) throw bad();
  const [payload, signature, extra] = cursor.split(".");
  if (!payload || !signature || extra !== undefined || !/^[0-9a-f]{32}$/.test(signature)) throw bad();
  if (!safeEqualHex(signature, cursorSignature(query, payload))) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const { v, t, i } = (parsed ?? {}) as Record<string, unknown>;
  if (v !== 1 || !Number.isSafeInteger(t) || (t as number) < 0 || typeof i !== "string" || !/^[0-9a-f]{24}$/.test(i))
    throw bad();
  return { at: new Date(t as number), id: new ObjectId(i) };
}

// --- shapes ----------------------------------------------------------------------------

function toProvider(owner: Owner): ServiceProviderSummary {
  return {
    id: owner._id.toHexString(),
    name: owner.fullName,
    photoUrl: owner.profile?.photo?.url ?? null,
    roleLabel: ROLE_LABELS[owner.role],
    credentialsVerified: owner.profile?.credentialStatus === "verified",
  };
}

function toCard(doc: ServiceDoc, owner: Owner): ServiceCard {
  const fixed = doc.pricing === "fixed";
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    category: doc.category as ServiceCard["category"],
    categoryLabel: marketplaceLabel(doc.category),
    description: doc.description,
    pricing: fixed ? "fixed" : "quote",
    priceNgn: fixed ? doc.priceNgn : null,
    durationMinutes: doc.durationMinutes,
    serviceStates: doc.serviceStates ?? [],
    provider: toProvider(owner),
  };
}

// --- reads -----------------------------------------------------------------------------

/**
 * One page of the directory, continuing after `cursor`. Reads at most
 * limit + 1 services, each with its owner joined in the same query.
 */
export async function searchServiceDirectory(
  query: ServiceDirectoryQuery,
  cursor: string | null,
  limit: number,
): Promise<ServiceDirectoryPage> {
  const { services } = await bookingCollections();
  const filter = serviceDirectoryFilter(query);
  if (cursor) {
    const after = decodeServiceCursor(query, cursor);
    filter.$and = [{ $or: [{ createdAt: { $lt: after.at } }, { createdAt: after.at, _id: { $lt: after.id } }] }];
  }
  const docs = (await services
    .aggregate([
      { $match: filter },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $lookup: {
          from: "users",
          localField: "ownerUserId",
          foreignField: "_id",
          as: "owner",
          pipeline: [{ $project: OWNER_PROJECTION }],
        },
      },
      { $unwind: "$owner" },
      { $match: OWNER_ALLOWED },
      { $limit: limit + 1 },
    ])
    .toArray()) as (ServiceDoc & { owner: Owner })[];
  const page = docs.slice(0, limit);
  return {
    services: page.map((d) => toCard(d, d.owner)),
    nextCursor: docs.length > limit ? encodeServiceCursor(query, page[page.length - 1]) : null,
  };
}

/** A listed service's public page; null when it isn't listed (or the id is bad). */
export async function getMarketplaceService(
  id: unknown,
  viewerId: ObjectId | null,
): Promise<MarketplaceServiceDetails | null> {
  const _id = parseId(id);
  if (!_id) return null;
  const { services, users } = await bookingCollections();
  const doc = await services.findOne({ _id, ...LISTED });
  if (!doc) return null;
  const owner = await users.findOne({ _id: doc.ownerUserId }, { projection: OWNER_PROJECTION });
  if (!owner || !isListedService(doc, owner)) return null;
  return {
    ...toCard(doc, owner),
    included: doc.included ?? "",
    excluded: doc.excluded ?? "",
    requirements: doc.requirements ?? "",
    canBook: !viewerId || !viewerId.equals(owner._id),
  };
}

/** A provider's public page with their listed services; null unless they have at least one. */
export async function getServiceProvider(id: unknown): Promise<ServiceProviderProfile | null> {
  const _id = parseId(id);
  if (!_id) return null;
  const { services, users } = await bookingCollections();
  const owner = await users.findOne({ _id, status: "active" }, { projection: OWNER_PROJECTION });
  if (!owner || MARKETPLACE_ROLES[owner.role].length === 0) return null;
  const docs = await services
    .find({ ownerUserId: owner._id, ...LISTED })
    .sort({ createdAt: -1, _id: -1 })
    .limit(SERVICE_LIMITS.perOwner)
    .toArray();
  const listed = docs.filter((d) => isListedService(d, owner));
  if (listed.length === 0) return null;
  return {
    ...toProvider(owner),
    bio: owner.profile?.bio ?? "",
    location: owner.profile?.location ?? "",
    yearsOfExperience: owner.profile?.yearsOfExperience ?? null,
    services: listed.map((d) => toCard(d, owner)),
  };
}
