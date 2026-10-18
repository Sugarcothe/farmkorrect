import "server-only";
import { TRAINING_LIMITS } from "@/lib/training/types";
import { getCloudinaryConfig } from "./config";

// Course media is referenced, never uploaded through the app: an admin puts
// the file in the team's Cloudinary account (the same one profile and product
// photos use) and pastes its delivery URL. Only plain delivery URLs on that
// account's own cloud are accepted, of the expected kind and file type, with
// no query string, fragment, credentials or path tricks. The same check runs
// again whenever a URL is shown, so a URL that no longer passes (say the
// cloud name changed) is treated as unavailable rather than passed on.

export type MediaKind = "video" | "cover" | "pdf";

const RULES: Record<MediaKind, { resourceTypes: string[]; extensions: string[] }> = {
  video: { resourceTypes: ["video"], extensions: ["mp4", "webm"] },
  cover: { resourceTypes: ["image"], extensions: ["jpg", "jpeg", "png", "webp"] },
  // Cloudinary stores PDFs as "image" by default, or as "raw"
  pdf: { resourceTypes: ["image", "raw"], extensions: ["pdf"] },
};

/** One path segment: a transformation ("q_auto,w_800"), a version ("v1712") or part of a public id. */
const SEGMENT = /^[A-Za-z0-9_,:.-]{1,200}$/;

export const MEDIA_HINT: Record<MediaKind, string> = {
  video: "Paste the Cloudinary delivery URL of an MP4 or WebM video in the team's account.",
  cover: "Paste the Cloudinary delivery URL of a JPG, PNG or WebP image in the team's account.",
  pdf: "Paste the Cloudinary delivery URL of a PDF in the team's account.",
};

export const MEDIA_UNCONFIGURED = "Media storage isn't set up, so course media can't be added yet.";

function cloudName(): string | null {
  try {
    return getCloudinaryConfig()?.cloudName ?? null;
  } catch {
    return null;
  }
}

export const isMediaConfigured = () => cloudName() !== null;

/** The URL, normalised, when it's an acceptable reference of this kind; otherwise null. */
export function checkMediaUrl(value: unknown, kind: MediaKind): string | null {
  const cloud = cloudName();
  if (!cloud || typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > TRAINING_LIMITS.mediaUrl) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.port) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  // the raw text must already be in its plain form: no encoded characters or dot segments
  if (url.href !== text) return null;
  const [empty, cloudSegment, resourceType, delivery, ...rest] = url.pathname.split("/");
  const rule = RULES[kind];
  if (empty !== "" || cloudSegment !== cloud || delivery !== "upload" || !rule.resourceTypes.includes(resourceType))
    return null;
  if (rest.length === 0 || !rest.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) return null;
  const extension = rest[rest.length - 1].split(".").pop()?.toLowerCase() ?? "";
  if (!rule.extensions.includes(extension)) return null;
  return url.href;
}
