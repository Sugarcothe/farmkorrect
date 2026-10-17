import "server-only";
import sharp from "sharp";
import { PHOTO_RULES } from "@/lib/profile/config";
import { HttpError } from "./http";

// Photos (profile and product) are never stored as uploaded: the bytes must
// really be a JPEG, PNG or WebP image, and they're decoded and re-encoded to
// a WebP so metadata (GPS location, camera details) and anything smuggled
// inside the original file is dropped.

export type PhotoType = (typeof PHOTO_RULES.types)[number];

export const AVATAR_SIZE = 512;
/** product photos fit inside this square, keeping their shape */
export const PRODUCT_PHOTO_SIZE = 1600;
/** refuse decompression bombs: 40 megapixels is well above any phone camera */
export const MAX_INPUT_PIXELS = 40_000_000;

const UNREADABLE = "We couldn't read that image. Choose a JPG, PNG or WebP photo.";

/** The image type the file's first bytes identify, regardless of what the client claimed. */
export function sniffImageType(bytes: Uint8Array): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

export function declaredPhotoType(contentType: string | null): PhotoType | null {
  const type = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  return (PHOTO_RULES.types as readonly string[]).includes(type) ? (type as PhotoType) : null;
}

export type ProcessedPhoto = { data: Buffer; width: number; height: number };

/** Not empty, and really the type it was sent as. */
function checkUpload(bytes: Buffer, declared: PhotoType) {
  if (bytes.byteLength === 0) throw new HttpError(400, "Choose a photo to upload.");
  if (sniffImageType(bytes) !== declared) throw new HttpError(400, UNREADABLE);
}

/** Validates and re-encodes an upload into a square WebP avatar. */
export async function processAvatar(bytes: Buffer, declared: PhotoType): Promise<ProcessedPhoto> {
  checkUpload(bytes, declared);

  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate() // honour the camera's orientation before the EXIF data is dropped
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new HttpError(400, UNREADABLE);
  }
}

/**
 * Validates and re-encodes a product photo: shrunk (never enlarged or
 * cropped) to fit PRODUCT_PHOTO_SIZE, as WebP, with all metadata dropped.
 */
export async function processProductPhoto(bytes: Buffer, declared: PhotoType): Promise<ProcessedPhoto> {
  checkUpload(bytes, declared);

  // the header gives the size without decoding the pixels
  let pixels: number;
  try {
    const { width, height } = await sharp(bytes, { limitInputPixels: false }).metadata();
    if (!width || !height) throw new Error("no size");
    pixels = width * height;
  } catch {
    throw new HttpError(400, UNREADABLE);
  }
  if (pixels > MAX_INPUT_PIXELS)
    throw new HttpError(400, `That photo's dimensions are too large. Choose one under ${MAX_INPUT_PIXELS / 1_000_000} megapixels.`);

  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize(PRODUCT_PHOTO_SIZE, PRODUCT_PHOTO_SIZE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new HttpError(400, UNREADABLE);
  }
}
