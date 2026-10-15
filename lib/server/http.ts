import "server-only";
import type { ApiResult } from "@/lib/auth/types";
import { ConfigError, getAuthConfig } from "./config";

// Shared plumbing for the /api route handlers: ApiResult responses, body
// parsing with a size cap, same-origin (CSRF) checks, client IPs and cookies.

/** Thrown inside a handler to end the request with an ApiResult error. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly fieldErrors?: Record<string, string>,
    readonly headers?: HeadersInit,
  ) {
    super(publicMessage);
    this.name = "HttpError";
  }
}

export function ok<T>(data: T, init: { status?: number; headers?: Headers } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  const body: ApiResult<T> = { ok: true, data };
  return Response.json(body, { status: init.status ?? 200, headers });
}

export function fail(
  status: number,
  error: string,
  fieldErrors?: Record<string, string>,
  extraHeaders?: HeadersInit,
) {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  const body: ApiResult = fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
  return Response.json(body, { status, headers });
}

export function tooManyRequests(retryAfterSeconds: number, message?: string): HttpError {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return new HttpError(
    429,
    message ??
      `Too many attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`,
    undefined,
    { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
  );
}

/**
 * Wraps a route handler (and passes on its context, e.g. dynamic params):
 * HttpErrors become ApiResult responses, and anything
 * else is logged by name/code only (never request bodies) and reported as a
 * generic failure.
 */
export function route(
  name: string,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response>;
export function route<Context>(
  name: string,
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response>;
export function route(
  name: string,
  handler: (request: Request, context?: unknown) => Promise<Response>,
) {
  return async (request: Request, context?: unknown) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof HttpError)
        return fail(error.status, error.publicMessage, error.fieldErrors, error.headers);
      if (error instanceof ConfigError) {
        console.error(`[${name}] configuration error: ${error.message}`);
        return fail(503, "This service isn't available right now. Please try again later.");
      }
      const label = error instanceof Error ? error.name : typeof error;
      const code = (error as { code?: unknown } | null)?.code;
      console.error(`[${name}] failed: ${label}${code !== undefined ? ` (code ${String(code)})` : ""}`);
      return fail(500, "Something went wrong on our side. Please try again.");
    }
  };
}

export const MAX_JSON_BYTES = 8 * 1024;

/**
 * Same-origin gate for every state-changing request. Browsers always send
 * Origin on POST; requiring it to match APP_URL (together with the JSON
 * content type readJsonBody demands, which a plain HTML form can't send)
 * blocks cross-site request forgery on top of the SameSite=Lax cookie.
 */
export function assertSameOrigin(request: Request) {
  const { appOrigin } = getAuthConfig();
  const origin = request.headers.get("origin");
  if (origin !== appOrigin) {
    throw new HttpError(403, "This request isn't allowed.");
  }
}

/**
 * Reads the whole body, refusing anything over maxBytes. The Content-Length
 * header can be absent or wrong, so the bytes actually received are counted.
 */
export async function readLimitedBody(
  request: Request,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, tooLargeMessage);

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, tooLargeMessage);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON object body, rejecting other content types and oversized bodies. */
export async function readJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type))
    throw new HttpError(415, "Requests must be sent as JSON.");

  const raw = await readLimitedBody(request, maxBytes, "This request is too large.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "The request couldn't be read. Please try again.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HttpError(400, "The request couldn't be read. Please try again.");
  return parsed as Record<string, unknown>;
}

/** A string field, or "" when absent or not a string. */
export function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

/**
 * The caller's IP, only when the deployment sits behind a proxy that sets
 * these headers (TRUST_PROXY_HEADERS=true); otherwise they could be forged,
 * so IP-based limits are skipped and the per-account limits still apply.
 */
export function clientIp(request: Request): string | null {
  if (!getAuthConfig().trustProxyHeaders) return null;
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  const { cookieName, secureCookies } = getAuthConfig();
  return [
    `${cookieName}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secureCookies ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return sessionCookie("", 0);
}

