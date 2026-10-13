import type { FarmType, Role } from "@/lib/auth/types";

// The profile contract shared by GET/PATCH /api/profile, the Profile screens
// and the server. Only the signed-in user's own profile is ever returned.

/**
 * A professional's registration number (e.g. VCN) goes through review:
 * submitting or changing one makes it "pending"; only a reviewer can mark it
 * "verified". Nothing in the app sets "verified" on its own.
 */
export type CredentialStatus = "not_submitted" | "pending" | "verified" | "rejected";

/** Every field the edit form can send; each role may change only some of them. */
export type ProfileField =
  | "fullName"
  | "bio"
  | "location"
  | "yearsOfExperience"
  | "farmName"
  | "farmType"
  | "birdCount"
  | "specialization"
  | "qualifications"
  | "registrationNumber";

export type Profile = {
  role: Role;
  fullName: string;
  /** shown for reference; changing them needs re-verification, so they're read-only here */
  email: string;
  phone: string;
  photoUrl: string | null;
  bio: string;
  /** farmers: the farm's location; professionals: where they practise */
  location: string;
  yearsOfExperience: number | null;
  /** farmers only; null until farm setup is done */
  farm: { farmName: string; farmType: FarmType; birdCount: number } | null;
  /** veterinarians and specialists; "" when not set */
  specialization: string;
  qualifications: string;
  registrationNumber: string;
  credentialStatus: CredentialStatus;
};

/** PATCH /api/profile body: any subset of the fields the user's role may change. */
export type ProfileUpdateRequest = Partial<{
  fullName: string;
  bio: string;
  location: string;
  yearsOfExperience: number;
  farmName: string;
  farmType: FarmType;
  birdCount: number;
  specialization: string;
  qualifications: string;
  registrationNumber: string;
}>;

export type ProfileResponse = { profile: Profile };

export type ProfilePhotoResponse = { photoUrl: string };
