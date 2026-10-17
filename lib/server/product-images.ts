import "server-only";
import { randomBytes } from "node:crypto";
import type { ObjectId } from "mongodb";
import { PRODUCT_PHOTO_RULES } from "@/lib/orders/types";
import { destroyImage, uploadImage } from "./cloudinary";
import { getDb } from "./db";
import { HttpError } from "./http";
import type { ProcessedPhoto } from "./images";
import { COLLECTIONS, type ProductDoc, type ProductImageDoc } from "./models";
import { ownedBy, parseObjectId } from "./products";

// A listing's photos. The bytes live at Cloudinary under ids this server
// makes up; the product only keeps references, main photo first. Storage and
// database are kept consistent in the safe direction:
// - adding uploads first and records the photo only if the listing still
//   exists and has room; otherwise the new upload is deleted again;
// - removing takes the photo off the listing first and deletes the file
//   only after that succeeded, so a listing never points at a deleted file.
// The worst case (a delete at Cloudinary failing) leaves an unused file, never
// a broken listing.

const MAX = PRODUCT_PHOTO_RULES.maxPhotos;

export const PHOTO_LIMIT_REACHED = `You can add up to ${MAX} photos. Remove one to add another.`;
export const PHOTO_NOT_FOUND = "We couldn't find that photo. It may have been removed already.";

async function products() {
  return (await getDb()).collection<ProductDoc>(COLLECTIONS.products);
}

/** Our photo ids: 16 hex digits. */
const parseImageId = (id: unknown): string | null => (typeof id === "string" && /^[0-9a-f]{16}$/.test(id) ? id : null);

/**
 * Checks the seller's listing exists and has room, before an upload is read
 * and processed. null when it isn't theirs (or doesn't exist).
 */
export async function findListingWithRoom(sellerUserId: ObjectId, id: string): Promise<ProductDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  const doc = await (await products()).findOne(ownedBy(sellerUserId, _id));
  if (doc && (doc.images?.length ?? 0) >= MAX) throw new HttpError(409, PHOTO_LIMIT_REACHED);
  return doc;
}

/** Stores a processed photo and adds it last. null when the listing isn't the seller's. */
export async function addProductPhoto(sellerUserId: ObjectId, id: string, photo: ProcessedPhoto): Promise<ProductDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  const collection = await products();
  const stored = await uploadImage(photo.data, "product");
  const now = new Date();
  const image: ProductImageDoc = {
    id: randomBytes(8).toString("hex"),
    publicId: stored.publicId,
    url: stored.url,
    width: photo.width,
    height: photo.height,
    addedAt: now,
  };

  let saved: ProductDoc | null;
  try {
    saved = await collection.findOneAndUpdate(
      // the count is checked again in the write itself, so two uploads at once can't pass the limit
      { ...ownedBy(sellerUserId, _id), [`images.${MAX - 1}`]: { $exists: false } },
      { $push: { images: image }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
  } catch (error) {
    await destroyImage(stored.publicId);
    throw error;
  }
  if (saved) return saved;

  await destroyImage(stored.publicId);
  if (await collection.findOne(ownedBy(sellerUserId, _id), { projection: { _id: 1 } }))
    throw new HttpError(409, PHOTO_LIMIT_REACHED);
  return null;
}

/** Removes one photo. null when the listing isn't the seller's; 404 when the photo isn't on it. */
export async function removeProductPhoto(sellerUserId: ObjectId, id: string, imageId: string): Promise<ProductDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  const collection = await products();
  const photoId = parseImageId(imageId);
  const now = new Date();
  const before = photoId
    ? await collection.findOneAndUpdate(
        { ...ownedBy(sellerUserId, _id), "images.id": photoId },
        { $pull: { images: { id: photoId } }, $set: { updatedAt: now } },
        { returnDocument: "before" },
      )
    : null;
  if (!before) {
    if (!(await collection.findOne(ownedBy(sellerUserId, _id), { projection: { _id: 1 } }))) return null;
    throw new HttpError(404, PHOTO_NOT_FOUND);
  }
  const removed = before.images?.find((i) => i.id === photoId);
  // only once the listing no longer refers to it
  if (removed) await destroyImage(removed.publicId);
  return { ...before, images: (before.images ?? []).filter((i) => i.id !== photoId), updatedAt: now };
}

/** Makes one photo the main one (first); the others keep their order. */
export async function setMainProductPhoto(sellerUserId: ObjectId, id: string, imageId: string): Promise<ProductDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  const collection = await products();
  const photoId = parseImageId(imageId);
  const saved = photoId
    ? await collection.findOneAndUpdate(
        { ...ownedBy(sellerUserId, _id), "images.id": photoId },
        [
          {
            $set: {
              images: {
                $concatArrays: [
                  { $filter: { input: "$images", cond: { $eq: ["$$this.id", { $literal: photoId }] } } },
                  { $filter: { input: "$images", cond: { $ne: ["$$this.id", { $literal: photoId }] } } },
                ],
              },
              updatedAt: "$$NOW",
            },
          },
        ],
        { returnDocument: "after" },
      )
    : null;
  if (saved) return saved;
  if (!(await collection.findOne(ownedBy(sellerUserId, _id), { projection: { _id: 1 } }))) return null;
  throw new HttpError(404, PHOTO_NOT_FOUND);
}
