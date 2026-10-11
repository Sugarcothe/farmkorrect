import "server-only";
import { getFixedOtpCode, getTermiiConfig, isDevSmsConsoleEnabled } from "../config";

// Nigerian SMS delivery through Termii's Messaging API
// (POST {base}/api/sms/send). Only the outcome is reported back; message text,
// phone numbers and provider responses are never logged.

export type DeliveryResult = { delivered: true } | { delivered: false; reason: string };

export function isSmsConfigured(): boolean {
  return getTermiiConfig() !== null || isDevSmsConsoleEnabled();
}

export async function sendSms(toE164: string, message: string): Promise<DeliveryResult> {
  const config = getTermiiConfig();
  if (!config) {
    if (getFixedOtpCode() !== null) return { delivered: true };
    if (!isDevSmsConsoleEnabled()) return { delivered: false, reason: "not_configured" };
    // development only (see isDevSmsConsoleEnabled): the terminal is the "phone"
    console.info(`
[dev sms] to ${toE164}: ${message}
`);
    return { delivered: true };
  }

  try {
    const res = await fetch(`${config.baseUrl}/api/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: config.apiKey,
        to: toE164.replace(/^\+/, ""),
        from: config.senderId,
        sms: message,
        type: "plain",
        channel: config.channel,
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { message_id?: unknown } | null;
    if (res.ok && body && typeof body.message_id === "string" && body.message_id) {
      return { delivered: true };
    }
    console.error(`[termii] SMS not accepted (HTTP ${res.status})`);
    return { delivered: false, reason: `http_${res.status}` };
  } catch (error) {
    console.error(`[termii] SMS request failed: ${error instanceof Error ? error.name : "unknown"}`);
    return { delivered: false, reason: "network" };
  }
}
