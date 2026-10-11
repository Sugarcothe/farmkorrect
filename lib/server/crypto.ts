import "server-only";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 256-bit random token, URL-safe (session ids, reset tokens). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Uniformly random six-digit code, zero-padded. */
export function randomOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Hash for high-entropy tokens (sessions, reset links). A plain SHA-256 is
 * enough here because the input can't be guessed or enumerated.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Keyed hash for low-entropy values (six-digit OTPs, rate-limit keys). Without
 * the server secret a leaked database can't be enumerated offline.
 */
export function hmac(secret: string, ...parts: string[]): string {
  return createHmac("sha256", secret).update(parts.join("\u0000")).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
