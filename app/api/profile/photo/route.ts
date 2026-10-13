import { PHOTO_RULES } from "@/lib/profile/config";
import type { ProfilePhotoResponse } from "@/lib/profile/types";
import { declaredPhotoType, processAvatar } from "@/lib/server/images";
import {
  assertSameOrigin,
  HttpError,
  ok,
  readLimitedBody,
  route,
  tooManyRequests,
} from "@/lib/server/http";
import { deleteProfilePhoto, findProfilePhoto, photoUrl, saveProfilePhoto } from "@/lib/server/profile";
import { hit } from "@/lib/server/rate-limit";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in user's profile photo. Uploads are the raw image bytes (not a
// form), capped in size, checked by their actual content and re-encoded
// before storage. The photo is only served to its owner and never cached.

const MAX_MB = PHOTO_RULES.maxBytes / (1024 * 1024);

const UNVERIFIED = "Verify your phone number before managing your profile.";

export const GET = route("profile-photo", async (request) => {
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  const photo = await findProfilePhoto(user._id);
  if (!photo) throw new HttpError(404, "No profile photo has been added.");
  return new Response(new Uint8Array(photo.data.buffer), {
    headers: {
      "Content-Type": photo.contentType,
      "Content-Length": String(photo.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
});

export const POST = route("profile-photo", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);

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
  const updatedAt = await saveProfilePhoto(user._id, avatar);
  return ok<ProfilePhotoResponse>({ photoUrl: photoUrl(updatedAt) });
});

export const DELETE = route("profile-photo", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  await deleteProfilePhoto(user._id);
  return ok(null);
});
