// Messages the app tried to send during a test (never actually delivered).
export const outbox = {
  sms: [] as { to: string; text: string }[],
  email: [] as { to: string; subject: string; text: string }[],
  smsFailing: false,
};

/** Work scheduled with next/server `after()`; run it with flushAfter(). */
export const pendingAfter: (() => unknown)[] = [];

export function resetOutbox() {
  outbox.sms.length = 0;
  outbox.email.length = 0;
  outbox.smsFailing = false;
  pendingAfter.length = 0;
}

export async function flushAfter() {
  while (pendingAfter.length) await pendingAfter.shift()!();
}

/** The six-digit code in the latest SMS to a number (E.164). */
export function lastOtp(phone: string): string {
  const to = phone.replace(/^\+/, "");
  const message = outbox.sms.filter((m) => m.to === to).at(-1);
  const code = message?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`No verification code was sent to ${phone}`);
  return code;
}

/** The token from the latest password-reset message to a number. */
export function lastResetToken(phone: string): string {
  const to = phone.replace(/^\+/, "");
  const message = outbox.sms.filter((m) => m.to === to && m.text.includes("reset-password")).at(-1);
  const token = message?.text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error(`No reset link was sent to ${phone}`);
  return token;
}
