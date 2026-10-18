import "server-only";
import { ObjectId, type UpdateFilter } from "mongodb";
import { isBookable, isMarketplaceCategory, marketplaceLabel, SERVICE_LIMITS } from "@/lib/services/config";
import type { Service, ServiceFields } from "@/lib/services/types";
import { searchWords } from "@/lib/vets/query";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type ServiceDoc } from "./models";

// The signed-in user's own services. Every query is scoped to the owner from
// the server-side session together with the service id, so an id belonging
// to someone else behaves exactly like one that doesn't exist. Removed
// services are archived (kept for future booking history) and never shown.

async function services() {
  return (await getDb()).collection<ServiceDoc>(COLLECTIONS.services);
}

export function toService(doc: ServiceDoc): Service {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    category: doc.category,
    description: doc.description,
    priceNgn: doc.priceNgn,
    durationMinutes: doc.durationMinutes,
    active: doc.active,
    bookingAvailable: doc.bookingAvailable,
    bookable: isBookable(doc),
    pricing: doc.pricing ?? null,
    serviceStates: doc.serviceStates ?? [],
    included: doc.included ?? "",
    excluded: doc.excluded ?? "",
    requirements: doc.requirements ?? "",
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** A strict 24-hex-digit id, or null (ObjectId.isValid also accepts 12-byte strings). */
function parseServiceId(id: string): ObjectId | null {
  return /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}

function ownedBy(ownerUserId: ObjectId, id: ObjectId) {
  return { _id: id, ownerUserId, archivedAt: null };
}

/** Directory search words for a marketplace service (none for any other). */
export function serviceSearchWords(doc: Pick<ServiceDoc, "name" | "description" | "category">): string[] {
  return [...new Set(searchWords(`${doc.name} ${marketplaceLabel(doc.category)} ${doc.description}`))].slice(0, 80);
}

const MARKETPLACE_FIELDS = ["pricing", "serviceStates", "included", "excluded", "requirements", "searchWords"] as const;

export const SERVICE_NOT_FOUND = "We couldn't find that service. It may have been removed.";

export async function listServices(ownerUserId: ObjectId): Promise<Service[]> {
  const docs = await (await services())
    .find({ ownerUserId, archivedAt: null })
    .sort({ createdAt: -1, _id: -1 })
    .limit(SERVICE_LIMITS.perOwner)
    .toArray();
  return docs.map(toService);
}

/** The owner's service with this id, or null — including when someone else owns it. */
export async function findOwnService(ownerUserId: ObjectId, id: string): Promise<ServiceDoc | null> {
  const _id = parseServiceId(id);
  if (!_id) return null;
  return (await services()).findOne(ownedBy(ownerUserId, _id));
}

export async function createService(ownerUserId: ObjectId, fields: ServiceFields): Promise<ServiceDoc> {
  const collection = await services();
  const current = await collection.countDocuments({ ownerUserId, archivedAt: null });
  if (current >= SERVICE_LIMITS.perOwner)
    throw new HttpError(
      409,
      `You can list up to ${SERVICE_LIMITS.perOwner} services. Remove one you no longer offer to add another.`,
    );

  const now = new Date();
  const doc: ServiceDoc = {
    _id: new ObjectId(),
    ownerUserId,
    ...fields,
    ...(isMarketplaceCategory(fields.category) ? { searchWords: serviceSearchWords(fields) } : {}),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await collection.insertOne(doc);
  return doc;
}

/**
 * Applies a validated update to the owner's service (`current` is the stored
 * version it was validated against); null if it isn't theirs (or is gone).
 * A service moved out of the marketplace loses its marketplace details.
 */
export async function updateOwnService(
  ownerUserId: ObjectId,
  current: ServiceDoc,
  update: Partial<ServiceFields>,
): Promise<ServiceDoc | null> {
  const next = { ...current, ...update };
  const change: UpdateFilter<ServiceDoc> = isMarketplaceCategory(next.category)
    ? { $set: { ...update, searchWords: serviceSearchWords(next), updatedAt: new Date() } }
    : {
        $set: { ...update, updatedAt: new Date() },
        ...(isMarketplaceCategory(current.category)
          ? { $unset: Object.fromEntries(MARKETPLACE_FIELDS.map((key) => [key, ""])) }
          : {}),
      };
  return (await services()).findOneAndUpdate(ownedBy(ownerUserId, current._id), change, { returnDocument: "after" });
}

/** Archives the owner's service so it's no longer listed or bookable; false if it isn't theirs. */
export async function archiveOwnService(ownerUserId: ObjectId, id: string): Promise<boolean> {
  const _id = parseServiceId(id);
  if (!_id) return false;
  const now = new Date();
  const result = await (await services()).updateOne(ownedBy(ownerUserId, _id), {
    $set: { archivedAt: now, active: false, bookingAvailable: false, updatedAt: now },
  });
  return result.matchedCount === 1;
}
