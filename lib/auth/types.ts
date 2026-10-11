export const ROLES = [
  "poultry-farmer",
  "veterinarian",
  "non-vet-specialist",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  "poultry-farmer": "Poultry Farmer",
  veterinarian: "Veterinarian",
  "non-vet-specialist": "Non-Vet Specialist",
};

export const FARM_TYPES = ["broiler", "layer", "both"] as const;

export type FarmType = (typeof FARM_TYPES)[number];

export const FARM_TYPE_LABELS: Record<FarmType, string> = {
  broiler: "Broiler",
  layer: "Layer",
  both: "Both Broiler and Layer",
};

// Request bodies the /api endpoints accept. Phone numbers are always sent
// normalised to E.164 (+234XXXXXXXXXX).

export type RegisterRequest = {
  role: Role;
  fullName: string;
  email: string;
  phone: string;
  password: string;
};

export type LoginRequest = {
  /** email address or E.164 phone number */
  identifier: string;
  password: string;
};

export type VerifyOtpRequest = {
  phone: string;
  code: string;
};

export type ResendOtpRequest = {
  phone: string;
};

export type PasswordResetRequest = {
  identifier: string;
};

export type FarmSetupRequest = {
  farmName: string;
  location: string;
  farmType: FarmType;
  birdCount: number;
  yearsOfExperience: number;
};

export type ApiResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };
