import { PHOTO_RULES } from "@/lib/profile/config";
import type { ProfilePhotoResponse } from "@/lib/profile/types";
import { isImageStorageConfigured, PHOTO_UNAVAILABLE } from "@/lib/server/cloudinary";
import { declaredPhotoType, processAvatar } from "@/lib/server/images";
import {
  assertSameOrigin,
  HttpError,
  ok,
  readLimitedBody,
  route,
  tooManyRequests,
} from "@/lib/server/http";
import { deleteProfilePhoto, saveProfilePhoto } from "@/lib/server/profile";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in user's profile photo. Uploads are the raw image bytes (not a
// form), capped in size, checked by their actual content and re-encoded on
// this server; only the cleaned WebP is sent on to Cloudinary, which serves it.

const MAX_MB = PHOTO_RULES.maxBytes / (1024 * 1024);

const UNVERIFIED = "Verify your phone number before managing your profile.";

export const POST = route("profile-photo", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  if (!isImageStorageConfigured()) throw new HttpError(503, PHOTO_UNAVAILABLE);

  const declared = declaredPhotoType(request.headers.get("content-type"));
  if (!declared) throw new HttpError(415, "Choose a JPG, PNG or WebP photo.");

  const limit = await hit("photoUploadsPerUser", user._id.toHexString());
  if (limit.limited)
    throw tooManyRequests(limit.retryAfterSeconds, "You've changed your photo a lot recently. Please try again later.");

  const bytes = await readLimitedBody(
    request,
    PHOTO_RULES.maxBytes,
    `That photo is too large. Choose one under ${MAX_MB} MB.`,
  );
  const avatar = await processAvatar(bytes, declared);
  return ok<ProfilePhotoResponse>({ photoUrl: await saveProfilePhoto(user._id, avatar.data) });
});

export const DELETE = route("profile-photo", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  await deleteProfilePhoto(user._id);
  return ok(null);
});
