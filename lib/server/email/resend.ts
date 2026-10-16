import "server-only";
import { getResendConfig } from "../config";
import type { DeliveryResult } from "../sms/termii";

// Transactional email through Resend's REST API (POST /emails). Recipients and
// contents are never logged.

export function isEmailConfigured(): boolean {
  return getResendConfig() !== null;
}

export async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<DeliveryResult> {
  const config = getResendConfig();
  if (!config) return { delivered: false, reason: "not_configured" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.from, ...message, to: [message.to] }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (res.ok && body && typeof body.id === "string") return { delivered: true, messageId: body.id.slice(0, 100) };
    console.error(`[resend] email not accepted (HTTP ${res.status})`);
    return { delivered: false, reason: `http_${res.status}` };
  } catch (error) {
    console.error(`[resend] email request failed: ${error instanceof Error ? error.name : "unknown"}`);
    return { delivered: false, reason: "network" };
  }
}
