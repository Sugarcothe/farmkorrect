import { request } from "@/lib/auth/api";
import type { ProfilePhotoResponse, ProfileResponse, ProfileUpdateRequest } from "./types";

// Browser-side calls for the signed-in user's own profile. The session cookie
// identifies the account; no user id is ever sent.

export const updateProfile = (body: ProfileUpdateRequest) =>
  request<ProfileResponse>("/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Sends the file's raw bytes; the server checks and re-encodes them. */
export const uploadProfilePhoto = (file: File) =>
  request<ProfilePhotoResponse>("/api/profile/photo", {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
