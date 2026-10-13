import "server-only";

// Server-only configuration, read from the environment on demand so a missing
// variable fails the request that needs it with a clear message (naming the
// variable, never its value) instead of crashing unrelated pages.

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = read(name);
  if (!value) throw new ConfigError(`Missing required environment variable ${name}.`);
  return value;
}

export function getDatabaseConfig() {
  const uri = required("MONGODB_URI");
  if (!/^mongodb(\+srv)?:\/\//.test(uri))
    throw new ConfigError("MONGODB_URI must be a mongodb:// or mongodb+srv:// URI.");
  return { uri, dbName: read("MONGODB_DB_NAME") ?? "farmkorrect" };
}

export type AuthConfig = {
  /** canonical origin of the app (from APP_URL), e.g. https://app.farmkorret.ng */
  appOrigin: string;
  cookieName: string;
  secureCookies: boolean;
  /** key for OTP HMACs and rate-limit key hashing */
  secret: string;
  /** use x-forwarded-for / x-real-ip for client IPs (only behind a trusted proxy) */
  trustProxyHeaders: boolean;
};

export function getAuthConfig(): AuthConfig {
  const appUrl = required("APP_URL").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new ConfigError("APP_URL must be an absolute URL, e.g. https://example.com.");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal))
    throw new ConfigError("APP_URL must use https:// (http:// is only allowed for localhost).");
  if (url.pathname !== "/" || url.search || url.hash || url.username)
    throw new ConfigError("APP_URL must be an origin only, without a path, query or credentials.");

  const secret = required("AUTH_SECRET");
  if (secret.length < 32)
    throw new ConfigError("AUTH_SECRET must be at least 32 characters long.");

  const cookieName = read("SESSION_COOKIE_NAME") ?? "fk_session";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookieName))
    throw new ConfigError("SESSION_COOKIE_NAME may only contain letters, digits, _ and -.");

  return {
    appOrigin: url.origin,
    cookieName,
    // production always gets Secure cookies; locally only when served over https
    secureCookies: process.env.NODE_ENV === "production" || url.protocol === "https:",
    secret,
    trustProxyHeaders: read("TRUST_PROXY_HEADERS") === "true",
  };
}

export type TermiiConfig = {
  apiKey: string;
  senderId: string;
  baseUrl: string;
  channel: string;
};

/** null when SMS delivery hasn't been configured */
export function getTermiiConfig(): TermiiConfig | null {
  const apiKey = read("TERMII_API_KEY");
  const senderId = read("TERMII_SENDER_ID");
  if (!apiKey || !senderId) return null;
  const baseUrl = (read("TERMII_BASE_URL") ?? "https://v3.api.termii.com").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl))
    throw new ConfigError("TERMII_BASE_URL must be an absolute URL.");
  return { apiKey, senderId, baseUrl, channel: read("TERMII_CHANNEL") ?? "dnd" };
}

/**
 * Local development without an SMS provider: when SMS_DEV_CONSOLE=true and
 * Termii isn't configured, messages are printed to the server console instead
 * of texted. Codes still have to be entered and checked as normal. Never
 * honoured in production builds.
 */
export function isDevSmsConsoleEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && read("SMS_DEV_CONSOLE") === "true";
}

export type ResendConfig = { apiKey: string; from: string };
/** Demo only: while Termii isn't configured, every code is OTP_FIXED_CODE and no SMS is sent. */
export function getFixedOtpCode(): string | null {
  const code = read("OTP_FIXED_CODE");
  if (!code || getTermiiConfig() !== null) return null;
  if (!/^\d{6}$/.test(code)) throw new ConfigError("OTP_FIXED_CODE must be exactly six digits.");
  return code;
}

export type CloudinaryConfig = { cloudName: string; apiKey: string; apiSecret: string; folder: string };

/**
 * null when image uploads haven't been configured. Takes either the
 * dashboard's CLOUDINARY_URL (cloudinary://key:secret@cloud) or the three
 * separate variables.
 */
export function getCloudinaryConfig(): CloudinaryConfig | null {
  let cloudName = read("CLOUDINARY_CLOUD_NAME");
  let apiKey = read("CLOUDINARY_API_KEY");
  let apiSecret = read("CLOUDINARY_API_SECRET");
  const url = read("CLOUDINARY_URL");
  if (url) {
    const match = url.match(/^cloudinary:\/\/([^:@/]+):([^@/]+)@([^/?#]+)$/);
    if (!match) throw new ConfigError("CLOUDINARY_URL must look like cloudinary://<key>:<secret>@<cloud name>.");
    [, apiKey, apiSecret, cloudName] = match;
  }
  if (!cloudName || !apiKey || !apiSecret) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cloudName))
    throw new ConfigError("CLOUDINARY_CLOUD_NAME may only contain letters, digits, _ and -.");

  const folder = (read("CLOUDINARY_FOLDER") ?? "farm-korret/avatars").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(folder))
    throw new ConfigError("CLOUDINARY_FOLDER may only contain letters, digits, _, - and /.");
  return { cloudName, apiKey, apiSecret, folder };
}

/** null when email delivery hasn't been configured */
export function getResendConfig(): ResendConfig | null {
  const apiKey = read("RESEND_API_KEY");
  const from = read("EMAIL_FROM");
  return apiKey && from ? { apiKey, from } : null;
}
