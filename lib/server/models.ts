import type { Binary, ObjectId } from "mongodb";
import type { FarmType, Role } from "@/lib/auth/types";
import type { CredentialStatus } from "@/lib/profile/types";

// Shapes of the documents persisted in MongoDB. Nothing here is ever sent to
// the browser as-is; see the public types in lib/auth/types.ts.

export const COLLECTIONS = {
  users: "users",
  sessions: "sessions",
  otpChallenges: "otp_challenges",
  passwordResets: "password_resets",
  farms: "farms",
  rateLimits: "rate_limits",
  profilePhotos: "profile_photos",
} as const;

export type UserStatus = "pending_verification" | "active";

export type UserDoc = {
  _id: ObjectId;
  fullName: string;
  emailNormalized: string;
  /** E.164, e.g. +2348123456789 */
  phoneNormalized: string;
  /** Argon2id PHC string */
  passwordHash: string;
  role: Role;
  status: UserStatus;
  phoneVerifiedAt: Date | null;
  /** email verification isn't implemented yet, so this stays null */
  emailVerifiedAt: Date | null;
  /** pending accounts are removed by a TTL index if never verified */
  pendingExpiresAt?: Date;
  /** set the first time the user edits their profile; absent until then */
  profile?: UserProfileDoc;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Self-described profile details. Farmers' farm details live in the farms
 * collection; the photo itself lives in profile_photos.
 */
export type UserProfileDoc = {
  bio?: string;
  /** professionals: where they practise */
  location?: string;
  /** professionals: years in practice */
  yearsOfExperience?: number;
  specialization?: string;
  qualifications?: string;
  registrationNumber?: string;
  /**
   * Only ever "pending" from the app; "verified" or "rejected" is set by a
   * reviewer outside the profile API.
   */
  credentialStatus?: CredentialStatus;
  credentialSubmittedAt?: Date;
  /** when the current photo was saved; versions the photo URL */
  photoUpdatedAt?: Date;
};

/**
 * "pending" sessions only allow phone verification and code resends for a
 * freshly registered (or logged-in but unverified) account; "full" sessions
 * are issued once the phone is verified.
 */
export type SessionKind = "pending" | "full";

export type SessionDoc = {
  _id: ObjectId;
  userId: ObjectId;
  kind: SessionKind;
  /** SHA-256 of the opaque cookie value; the raw token is never stored */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type OtpPurpose = "phone_verification";

export type OtpChallengeDoc = {
  _id: ObjectId;
  userId: ObjectId;
  purpose: OtpPurpose;
  /** HMAC(AUTH_SECRET, challengeId, code) */
  codeHash: string;
  /** true for the one challenge per user and purpose that can still be used */
  active: boolean;
  attempts: number;
  expiresAt: Date;
  resendAvailableAt: Date;
  createdAt: Date;
  deliveredAt: Date | null;
  deliveryFailedAt: Date | null;
  consumedAt: Date | null;
  supersededAt: Date | null;
};

export type PasswordResetChannel = "sms" | "email";

export type PasswordResetDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /** SHA-256 of the token in the reset link */
  tokenHash: string;
  channel: PasswordResetChannel;
  createdAt: Date;
  expiresAt: Date;
  deliveredAt: Date | null;
  deliveryFailedAt: Date | null;
  usedAt: Date | null;
  supersededAt: Date | null;
};

export type FarmDoc = {
  _id: ObjectId;
  ownerUserId: ObjectId;
  /** the profile created during sign-up; at most one per owner */
  initialProfile: boolean;
  farmName: string;
  location: string;
  farmType: FarmType;
  birdCount: number;
  yearsOfExperience: number;
  createdAt: Date;
  updatedAt: Date;
};

/** One re-encoded avatar per user, kept out of the user document. */
export type ProfilePhotoDoc = {
  /** the owner's user id */
  _id: ObjectId;
  data: Binary;
  contentType: "image/webp";
  size: number;
  width: number;
  height: number;
  updatedAt: Date;
};

export type RateLimitDoc = {
  /** HMAC of scope + subject + window, so no raw IPs or identifiers are kept */
  _id: string;
  count: number;
  expiresAt: Date;
};
