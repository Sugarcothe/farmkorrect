import { PRODUCT_PHOTO_RULES } from "./types";

// Product photos in the browser: checks made before an upload starts (the
// server checks everything again) and the sizes photos are shown at.

const CLOUDINARY_UPLOAD = /^(https:\/\/res\.cloudinary\.com\/[a-z0-9_-]+\/image\/upload\/)(.+)$/i;

/**
 * A smaller copy of a stored photo for a thumbnail or card, made by
 * Cloudinary; only ever shrinks, never crops. Other addresses are returned
 * unchanged.
 */
export function photoUrl(url: string, width: number): string {
  const match = CLOUDINARY_UPLOAD.exec(url);
  return match ? `${match[1]}c_limit,w_${Math.round(width)}/${match[2]}` : url;
}

const MAX_MB = PRODUCT_PHOTO_RULES.maxBytes / (1024 * 1024);

/** Why this file can't be uploaded, or undefined if it looks fine. */
export function checkPhotoFile(file: { type: string; size: number }): string | undefined {
  if (!(PRODUCT_PHOTO_RULES.types as readonly string[]).includes(file.type)) return "Choose a JPG, PNG or WebP photo.";
  if (file.size === 0) return "That file is empty. Choose another photo.";
  if (file.size > PRODUCT_PHOTO_RULES.maxBytes) return `That photo is too large. Choose one under ${MAX_MB} MB.`;
}
