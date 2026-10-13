import "server-only";
import { Binary, ObjectId, type ClientSession, type Collection } from "mongodb";
import type { Profile } from "@/lib/profile/types";
import { getDb, getMongoClient } from "./db";
import { findInitialFarm } from "./farms";
import { HttpError } from "./http";
import { COLLECTIONS, type FarmDoc, type ProfilePhotoDoc, type UserDoc } from "./models";
import { users } from "./users";
import type { ProfileUpdate } from "./validation";

// The signed-in user's own profile. Every function takes the account from the
// server-side session; nothing here accepts a user id from a request.

async function photos() {
  return (await getDb()).collection<ProfilePhotoDoc>(COLLECTIONS.profilePhotos);
}

export function photoUrl(updatedAt: Date) {
  return `/api/profile/photo?v=${updatedAt.getTime()}`;
}

/**
 * Builds the public profile. Accounts that have never edited their profile
 * have no `profile` subdocument yet, so every field falls back to a safe
 * empty value; professionals' location and experience start from what they
 * entered during setup.
 */
export function toProfile(user: UserDoc, farm: FarmDoc | null): Profile {
  const details = user.profile ?? {};
  const isFarmer = user.role === "poultry-farmer";
  return {
    role: user.role,
    fullName: user.fullName,
    email: user.emailNormalized,
    phone: user.phoneNormalized,
    photoUrl: details.photoUpdatedAt ? photoUrl(details.photoUpdatedAt) : null,
    bio: details.bio ?? "",
    location: isFarmer ? (farm?.location ?? "") : (details.location ?? farm?.location ?? ""),
    yearsOfExperience: isFarmer
      ? (farm?.yearsOfExperience ?? null)
      : (details.yearsOfExperience ?? farm?.yearsOfExperience ?? null),
    farm:
      isFarmer && farm
        ? { farmName: farm.farmName, farmType: farm.farmType, birdCount: farm.birdCount }
        : null,
    specialization: isFarmer ? "" : (details.specialization ?? ""),
    qualifications: isFarmer ? "" : (details.qualifications ?? ""),
    registrationNumber: details.registrationNumber ?? "",
    credentialStatus: details.credentialStatus ?? "not_submitted",
  };
}

export async function getProfile(user: UserDoc): Promise<Profile> {
  return toProfile(user, await findInitialFarm(user._id));
}

const FARM_FIELDS = ["farmName", "location", "farmType", "birdCount", "yearsOfExperience"] as const;

/**
 * Applies a validated edit to the account's own user document (and, for
 * farmers, its farm) in one transaction, so a failure leaves both unchanged.
 * A new or changed registration number is always stored as "pending" review.
 */
export async function updateProfile(userId: ObjectId, update: ProfileUpdate): Promise<Profile> {
  const client = await getMongoClient();
  const userCollection = await users();
  const farmCollection = (await getDb()).collection<FarmDoc>(COLLECTIONS.farms);

  await client.withSession((dbSession) =>
    dbSession.withTransaction(async () => {
      const now = new Date();
      const user = await userCollection.findOne({ _id: userId, status: "active" }, { session: dbSession });
      if (!user) throw new HttpError(401, "Your session has ended. Please log in again.");

      const set: Record<string, unknown> = { updatedAt: now };
      const unset: Record<string, ""> = {};
      if (update.fullName !== undefined) set.fullName = update.fullName;
      if (update.bio !== undefined) set["profile.bio"] = update.bio;

      if (user.role === "poultry-farmer") {
        await updateFarm(farmCollection, userId, update, now, dbSession);
      } else {
        if (update.location !== undefined) set["profile.location"] = update.location;
        if (update.yearsOfExperience !== undefined)
          set["profile.yearsOfExperience"] = update.yearsOfExperience;
        if (update.specialization !== undefined) set["profile.specialization"] = update.specialization;
        if (update.qualifications !== undefined) set["profile.qualifications"] = update.qualifications;
        if (update.registrationNumber !== undefined)
          applyRegistrationNumber(user, update.registrationNumber, now, set, unset);
      }

      await userCollection.updateOne(
        { _id: userId },
        Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set },
        { session: dbSession },
      );
    }),
  );

  const user = await userCollection.findOne({ _id: userId });
  if (!user) throw new HttpError(401, "Your session has ended. Please log in again.");
  return getProfile(user);
}

function applyRegistrationNumber(
  user: UserDoc,
  number: string,
  now: Date,
  set: Record<string, unknown>,
  unset: Record<string, "">,
) {
  const current = user.profile?.registrationNumber ?? "";
  if (number === current) return;
  if (user.profile?.credentialStatus === "verified")
    throw new HttpError(400, "Please correct the highlighted fields.", {
      registrationNumber:
        "Your registration number has been verified, so it can't be changed here. Contact support to update it.",
    });

  if (!number) {
    unset["profile.registrationNumber"] = "";
    unset["profile.credentialSubmittedAt"] = "";
    set["profile.credentialStatus"] = "not_submitted";
    return;
  }
  // submitted, not verified: only a reviewer can change this to "verified"
  set["profile.registrationNumber"] = number;
  set["profile.credentialStatus"] = "pending";
  set["profile.credentialSubmittedAt"] = now;
}

async function updateFarm(
  farmCollection: Collection<FarmDoc>,
  ownerUserId: ObjectId,
  update: ProfileUpdate,
  now: Date,
  dbSession: ClientSession,
) {
  const changes: Partial<Pick<FarmDoc, (typeof FARM_FIELDS)[number]>> = {};
  for (const field of FARM_FIELDS) {
    if (update[field] !== undefined) Object.assign(changes, { [field]: update[field] });
  }
  if (Object.keys(changes).length === 0) return;

  const existing = await farmCollection.findOne(
    { ownerUserId, initialProfile: true },
    { session: dbSession, projection: { _id: 1 } },
  );
  if (existing) {
    await farmCollection.updateOne(
      { _id: existing._id },
      { $set: { ...changes, updatedAt: now } },
      { session: dbSession },
    );
    return;
  }

  // no farm yet (setup was skipped): creating one needs every farm detail
  const missing = FARM_FIELDS.filter((field) => update[field] === undefined);
  if (missing.length > 0)
    throw new HttpError(
      400,
      "Add all of your farm details to save them.",
      Object.fromEntries(missing.map((field) => [field, "Required to set up your farm."])),
    );
  await farmCollection.insertOne(
    {
      _id: new ObjectId(),
      ownerUserId,
      initialProfile: true,
      farmName: update.farmName!,
      location: update.location!,
      farmType: update.farmType!,
      birdCount: update.birdCount!,
      yearsOfExperience: update.yearsOfExperience!,
      createdAt: now,
      updatedAt: now,
    },
    { session: dbSession },
  );
}

/** Stores an already re-encoded photo and points the profile at it. */
export async function saveProfilePhoto(
  userId: ObjectId,
  image: { data: Buffer; width: number; height: number },
): Promise<Date> {
  const client = await getMongoClient();
  const photoCollection = await photos();
  const userCollection = await users();
  const now = new Date();

  await client.withSession((dbSession) =>
    dbSession.withTransaction(async () => {
      await photoCollection.replaceOne(
        { _id: userId },
        {
          data: new Binary(image.data),
          contentType: "image/webp",
          size: image.data.byteLength,
          width: image.width,
          height: image.height,
          updatedAt: now,
        },
        { upsert: true, session: dbSession },
      );
      await userCollection.updateOne(
        { _id: userId },
        { $set: { "profile.photoUpdatedAt": now, updatedAt: now } },
        { session: dbSession },
      );
    }),
  );
  return now;
}

export async function findProfilePhoto(userId: ObjectId): Promise<ProfilePhotoDoc | null> {
  return (await photos()).findOne({ _id: userId });
}

export async function deleteProfilePhoto(userId: ObjectId) {
  const client = await getMongoClient();
  const photoCollection = await photos();
  const userCollection = await users();
  await client.withSession((dbSession) =>
    dbSession.withTransaction(async () => {
      await photoCollection.deleteOne({ _id: userId }, { session: dbSession });
      await userCollection.updateOne(
        { _id: userId },
        { $unset: { "profile.photoUpdatedAt": "" }, $set: { updatedAt: new Date() } },
        { session: dbSession },
      );
    }),
  );
}
