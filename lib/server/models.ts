import type { ObjectId } from "mongodb";
import type { FarmType, Role } from "@/lib/auth/types";
import type { PayoutAccountStatus } from "@/lib/bank-details/types";
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
  services: "services",
  payoutAccounts: "payout_accounts",
  bankVerifications: "bank_verifications",
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
 * collection; the photo file itself is stored on Cloudinary.
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
  photo?: ProfilePhotoRef;
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

/** Where the current avatar is stored: a re-encoded WebP on Cloudinary. */
export type ProfilePhotoRef = {
  /** Cloudinary public id, used to delete the file once it's replaced */
  publicId: string;
  /** https delivery URL */
  url: string;
  width: number;
  height: number;
  updatedAt: Date;
};

/**
 * A service a user offers under Services & Pricing. Only the owner's id is
 * kept here; names, photos and other profile details stay on the user.
 */
export type ServiceDoc = {
  _id: ObjectId;
  ownerUserId: ObjectId;
  name: string;
  /** a value from SERVICE_CATEGORIES for the owner's role */
  category: string;
  description: string;
  /** whole naira; 0 means free */
  priceNgn: number;
  /** null when the duration varies */
  durationMinutes: number | null;
  active: boolean;
  /** only counts while the service is active */
  bookingAvailable: boolean;
  /** set when the owner removes the service; it's then hidden everywhere */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A bank account a user set up to receive payouts, one document per setup
 * attempt. The full account number is never stored: only its last four
 * digits and a keyed hash (to compare with later checks). Paystack's
 * recipient code is the reference future transfers will use.
 *
 * At most one document per owner is `current`, and only once its recipient
 * has been created. Replaced and failed attempts are kept as an audit trail.
 */
export type PayoutAccountDoc = {
  _id: ObjectId;
  ownerUserId: ObjectId;
  bankCode: string;
  bankName: string;
  accountNumberLast4: string;
  /** HMAC(AUTH_SECRET, bank code, account number) */
  accountFingerprint: string;
  /** as returned by Paystack's account resolution, never from the browser */
  accountName: string;
  status: PayoutAccountStatus;
  /** Paystack transfer recipient code, set once the recipient exists */
  recipientCode: string | null;
  /** the account payouts will go to; true only with status recipient_created */
  current: boolean;
  resolvedAt: Date;
  recipientCreatedAt: Date | null;
  failedAt: Date | null;
  /** set when a newer account took its place */
  replacedAt: Date | null;
  replacedBy: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A short-lived, single-use record of a successful account resolution,
 * linking the "check" and "confirm" steps. The browser only holds a random
 * token (stored here hashed); the account details stay on the server.
 */
export type BankVerificationDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /** SHA-256 of the token given to the browser */
  tokenHash: string;
  bankCode: string;
  bankName: string;
  /** HMAC(AUTH_SECRET, bank code, account number) */
  accountFingerprint: string;
  accountNumberLast4: string;
  accountName: string;
  /** true for the one check per user that can still be confirmed */
  active: boolean;
  createdAt: Date;
  expiresAt: Date;
  /** set while a confirmation is being processed, so it can't run twice */
  claimedAt: Date | null;
  consumedAt: Date | null;
  supersededAt: Date | null;
};

export type RateLimitDoc = {
  /** HMAC of scope + subject + window, so no raw IPs or identifiers are kept */
  _id: string;
  count: number;
  expiresAt: Date;
};
