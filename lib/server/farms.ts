import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import type { Farm } from "@/lib/auth/types";
import { getDb } from "./db";
import { COLLECTIONS, type FarmDoc } from "./models";
import type { FarmInput } from "./validation";

async function farms() {
  return (await getDb()).collection<FarmDoc>(COLLECTIONS.farms);
}

export function toFarm(doc: FarmDoc): Farm {
  return {
    id: doc._id.toHexString(),
    farmName: doc.farmName,
    location: doc.location,
    farmType: doc.farmType,
    birdCount: doc.birdCount,
    yearsOfExperience: doc.yearsOfExperience,
  };
}

/**
 * Creates the owner's initial farm profile, or updates it if it already
 * exists, so a double-submitted or retried Farm Setup form leaves exactly one
 * profile. The owner always comes from the session, never from the request.
 */
export async function saveInitialFarm(
  ownerUserId: ObjectId,
  input: FarmInput,
): Promise<{ farm: FarmDoc; created: boolean }> {
  const collection = await farms();
  const upsert = async () => {
    const now = new Date();
    const result = await collection.findOneAndUpdate(
      { ownerUserId, initialProfile: true },
      {
        $set: { ...input, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), ownerUserId, initialProfile: true, createdAt: now },
      },
      { upsert: true, returnDocument: "after", includeResultMetadata: true },
    );
    if (!result.value) throw new Error("Farm upsert returned no document");
    return { farm: result.value, created: !result.lastErrorObject?.updatedExisting };
  };

  try {
    return await upsert();
  } catch (error) {
    // two concurrent first submissions both tried to insert; the unique index
    // let one win, so the retry updates that document
    if (error instanceof MongoServerError && error.code === 11000) return upsert();
    throw error;
  }
}

export async function findInitialFarm(ownerUserId: ObjectId): Promise<FarmDoc | null> {
  return (await farms()).findOne({ ownerUserId, initialProfile: true });
}
