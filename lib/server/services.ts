import "server-only";
import { ObjectId } from "mongodb";
import { isBookable, SERVICE_LIMITS } from "@/lib/services/config";
import type { Service, ServiceFields } from "@/lib/services/types";
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
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await collection.insertOne(doc);
  return doc;
}

/** Applies a validated update to the owner's service; null if it isn't theirs (or is gone). */
export async function updateOwnService(
  ownerUserId: ObjectId,
  id: ObjectId,
  update: Partial<ServiceFields>,
): Promise<ServiceDoc | null> {
  return (await services()).findOneAndUpdate(
    ownedBy(ownerUserId, id),
    { $set: { ...update, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
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
