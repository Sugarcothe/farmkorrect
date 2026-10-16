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

export type PaystackConfig = { secretKey: string; mode: "test" | "live" };

/**
 * null when bank verification hasn't been configured. Server-only: the key
 * signs every Paystack request and must never reach the browser.
 */
export function getPaystackConfig(): PaystackConfig | null {
  const secretKey = read("PAYSTACK_SECRET_KEY");
  if (!secretKey) return null;
  const match = secretKey.match(/^sk_(test|live)_[A-Za-z0-9]+$/);
  if (!match) throw new ConfigError("PAYSTACK_SECRET_KEY must be a Paystack secret key (sk_test_… or sk_live_…).");
  return { secretKey, mode: match[1] as "test" | "live" };
}

/**
 * Whether payouts may be sent as Paystack transfers. Off unless
 * PAYSTACK_TRANSFERS_ENABLED is exactly "true" and a key is configured. A
 * live key is refused outside production, so a local or preview deployment
 * can never move real money by accident.
 */
export function getTransferConfig(): { enabled: boolean } {
  if (read("PAYSTACK_TRANSFERS_ENABLED") !== "true") return { enabled: false };
  const paystack = getPaystackConfig();
  if (!paystack) throw new ConfigError("PAYSTACK_TRANSFERS_ENABLED needs PAYSTACK_SECRET_KEY.");
  if (paystack.mode === "live" && process.env.NODE_ENV !== "production")
    throw new ConfigError("A live Paystack key can only send transfers in production.");
  return { enabled: true };
}

/**
 * Bearer secret for the internal payout processing endpoint (called by a
 * scheduler). null leaves that endpoint switched off.
 */
export function getPayoutJobSecret(): string | null {
  const secret = read("PAYOUT_JOB_SECRET");
  if (!secret) return null;
  if (secret.length < 32) throw new ConfigError("PAYOUT_JOB_SECRET must be at least 32 characters long.");
  return secret;
}

/**
 * Whether buyers can pay for orders through Paystack. Needs a secret key; a
 * live key is refused outside production, so a local or preview deployment
 * can never take a real customer's money.
 */
export function getPaymentConfig(): { enabled: boolean } {
  const paystack = getPaystackConfig();
  if (!paystack) return { enabled: false };
  if (paystack.mode === "live" && process.env.NODE_ENV !== "production")
    throw new ConfigError("A live Paystack key can only collect payments in production.");
  return { enabled: true };
}

export type CommissionPolicy = {
  /** a name for this policy, stored on every order it's applied to (e.g. "2026-11-standard") */
  id: string;
  /** the platform's share of an order's item subtotal, in basis points (250 = 2.5%) */
  rateBps: number;
};

/** The highest rate accepted (50%): anything above is almost certainly a typo. */
export const MAX_COMMISSION_BPS = 5_000;

/**
 * The platform commission, or null while none has been decided. There is
 * deliberately no default: until COMMISSION_POLICY_ID and
 * COMMISSION_RATE_BPS are both set, payments are still collected but sellers'
 * earnings aren't recorded (settlement waits for a policy).
 */
export function getCommissionPolicy(): CommissionPolicy | null {
  const id = read("COMMISSION_POLICY_ID");
  const rate = read("COMMISSION_RATE_BPS");
  if (!id && !rate) return null;
  if (!id || !rate) throw new ConfigError("COMMISSION_POLICY_ID and COMMISSION_RATE_BPS must be set together.");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(id))
    throw new ConfigError("COMMISSION_POLICY_ID may only contain letters, digits, ., _ and - (up to 40).");
  if (!/^\d{1,5}$/.test(rate) || Number(rate) > MAX_COMMISSION_BPS)
    throw new ConfigError(`COMMISSION_RATE_BPS must be a whole number of basis points from 0 to ${MAX_COMMISSION_BPS}.`);
  return { id, rateBps: Number(rate) };
}

/**
 * Bearer secret for the internal order endpoints (the scheduled job that
 * expires unpaid orders and reconciles payments and refunds, and closing a
 * reported issue). null leaves them switched off.
 */
export function getOrderJobSecret(): string | null {
  const secret = read("ORDER_JOB_SECRET");
  if (!secret) return null;
  if (secret.length < 32) throw new ConfigError("ORDER_JOB_SECRET must be at least 32 characters long.");
  return secret;
}

/** null when email delivery hasn't been configured */
export function getResendConfig(): ResendConfig | null {
  const apiKey = read("RESEND_API_KEY");
  const from = read("EMAIL_FROM");
  return apiKey && from ? { apiKey, from } : null;
}

/**
 * Bearer secret for POST /api/internal/notifications/process (a scheduler
 * calls it every minute or two to create any notifications still owed and
 * send queued email, SMS and push deliveries). null leaves it switched off.
 */
export function getNotificationJobSecret(): string | null {
  const secret = read("NOTIFICATION_JOB_SECRET");
  if (!secret) return null;
  if (secret.length < 32) throw new ConfigError("NOTIFICATION_JOB_SECRET must be at least 32 characters long.");
  return secret;
}

export type WebPushConfig = { publicKey: string; privateKey: string; subject: string };

/**
 * null while Web Push isn't set up. Needs a VAPID key pair (generate one
 * with `npx web-push generate-vapid-keys`) and a contact subject (mailto:
 * or https:). The private key is server-only.
 */
export function getWebPushConfig(): WebPushConfig | null {
  const publicKey = read("WEB_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = read("WEB_PUSH_VAPID_PRIVATE_KEY");
  const subject = read("WEB_PUSH_SUBJECT");
  if (!publicKey && !privateKey && !subject) return null;
  if (!publicKey || !privateKey || !subject)
    throw new ConfigError("WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_SUBJECT must be set together.");
  // an uncompressed P-256 public key is 65 bytes, the private key 32 (base64url)
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(publicKey))
    throw new ConfigError("WEB_PUSH_VAPID_PUBLIC_KEY must be a base64url VAPID public key.");
  if (!/^[A-Za-z0-9_-]{42,44}$/.test(privateKey))
    throw new ConfigError("WEB_PUSH_VAPID_PRIVATE_KEY must be a base64url VAPID private key.");
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject))
    throw new ConfigError("WEB_PUSH_SUBJECT must be a mailto: address or an https:// URL.");
  return { publicKey, privateKey, subject };
}
