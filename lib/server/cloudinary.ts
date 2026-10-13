import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getCloudinaryConfig, type CloudinaryConfig } from "./config";
import { HttpError } from "./http";

// Image storage on Cloudinary through its signed Upload API. Requests are
// signed on the server with the API secret, which never leaves it; the
// browser only ever sees the delivery URL. Provider responses are never
// logged or passed on.

export type StoredImage = { publicId: string; url: string; width: number; height: number };

export const PHOTO_UNAVAILABLE = "Photo uploads aren't available right now. Please try again later.";
const FAILED = "We couldn't save your photo right now. Please try again.";

export function isImageStorageConfigured(): boolean {
  return getCloudinaryConfig() !== null;
}

function requireConfig(): CloudinaryConfig {
  const config = getCloudinaryConfig();
  if (!config) throw new HttpError(503, PHOTO_UNAVAILABLE);
  return config;
}

/** Cloudinary's request signature: sorted `key=value` pairs joined with &, then the secret, SHA-1. */
export function signParams(params: Record<string, string>, apiSecret: string): string {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash("sha1").update(payload + apiSecret).digest("hex");
}

async function post(config: CloudinaryConfig, action: "upload" | "destroy", params: Record<string, string>, file?: Blob) {
  const signed = { ...params, timestamp: String(Math.floor(Date.now() / 1000)) };
  const form = new FormData();
  for (const [key, value] of Object.entries(signed)) form.set(key, value);
  form.set("api_key", config.apiKey);
  form.set("signature", signParams(signed, config.apiSecret));
  if (file) form.set("file", file);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/${action}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(action === "upload" ? 20_000 : 10_000),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, ok: res.ok, body };
}

/** Uploads an already validated and re-encoded WebP under a new, unguessable id. */
export async function uploadImage(data: Buffer): Promise<StoredImage> {
  const config = requireConfig();
  const publicId = `${config.folder}/${randomBytes(16).toString("hex")}`;
  try {
    const { ok, status, body } = await post(
      config,
      "upload",
      { public_id: publicId, overwrite: "false" },
      new Blob([new Uint8Array(data)], { type: "image/webp" }),
    );
    const url = body?.secure_url;
    if (
      ok &&
      body?.public_id === publicId &&
      typeof url === "string" &&
      url.startsWith(`https://res.cloudinary.com/${config.cloudName}/`)
    ) {
      return { publicId, url, width: Number(body.width) || 0, height: Number(body.height) || 0 };
    }
    console.error(`[cloudinary] upload not accepted (HTTP ${status})`);
  } catch (error) {
    console.error(`[cloudinary] upload failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
  throw new HttpError(502, FAILED);
}

/**
 * Best-effort removal of an image that is no longer referenced. A failure
 * only leaves an orphaned file behind, so it's reported, never thrown.
 */
export async function destroyImage(publicId: string): Promise<boolean> {
  const config = getCloudinaryConfig();
  if (!config) return false;
  try {
    const { ok, status, body } = await post(config, "destroy", { public_id: publicId, invalidate: "true" });
    if (ok && (body?.result === "ok" || body?.result === "not found")) return true;
    console.error(`[cloudinary] delete not accepted (HTTP ${status})`);
  } catch (error) {
    console.error(`[cloudinary] delete failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
  return false;
}
