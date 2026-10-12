import "server-only";
import { ObjectId } from "mongodb";
import { getAuthConfig } from "./config";
import { hashToken, randomToken } from "./crypto";
import { getDb, getMongoClient } from "./db";
import { isEmailConfigured, sendEmail } from "./email/resend";
import { COLLECTIONS, type PasswordResetChannel, type PasswordResetDoc, type UserDoc } from "./models";
import { revokeUserSessions } from "./sessions";
import { sendSms, type DeliveryResult } from "./sms/termii";
import { updatePasswordHash } from "./users";

// Password recovery with single-use, 30-minute links. The token lives only in
// the link (after the #, so it never reaches server logs or Referer headers);
// MongoDB keeps its SHA-256.
//
// Delivery: email via Resend once an address has been verified; until then
// (email verification isn't built yet) the link goes by SMS to the phone the
// user already proved they own, so instructions are never sent to an address
// nobody has confirmed.

export const RESET_TTL_MS = 30 * 60_000;

async function resets() {
  return (await getDb()).collection<PasswordResetDoc>(COLLECTIONS.passwordResets);
}

export function resetChannelFor(user: UserDoc): PasswordResetChannel {
  return user.emailVerifiedAt && isEmailConfigured() ? "email" : "sms";
}

export function resetLink(token: string) {
  // built only from the validated APP_URL, never from request headers
  return `${getAuthConfig().appOrigin}/auth/reset-password#token=${token}`;
}

/** Issues a new reset link for an account (retiring older ones) and sends it. */
export async function sendPasswordReset(user: UserDoc): Promise<DeliveryResult> {
  const collection = await resets();
  const now = new Date();
  const channel = resetChannelFor(user);
  const token = randomToken();
  const id = new ObjectId();

  await collection.updateMany(
    { userId: user._id, usedAt: null, supersededAt: null },
    { $set: { supersededAt: now } },
  );
  await collection.insertOne({
    _id: id,
    userId: user._id,
    tokenHash: hashToken(token),
    channel,
    createdAt: now,
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
    deliveredAt: null,
    deliveryFailedAt: null,
    usedAt: null,
    supersededAt: null,
  });

  const link = resetLink(token);
  const result =
    channel === "email"
      ? await sendEmail({
          to: user.emailNormalized,
          subject: "Reset your Farm Korect Nig password",
          text: `Hi ${user.fullName},\n\nUse this link to choose a new password. It expires in 30 minutes and can be used once:\n\n${link}\n\nIf you didn't ask to reset your password, ignore this email — your password won't change.`,
          html: resetEmailHtml(user.fullName, link),
        })
      : await sendSms(
          user.phoneNormalized,
          `Reset your Farm Korect Nig password (link valid 30 min, single use): ${link} If you didn't request this, ignore this message.`,
        );

  await collection.updateOne(
    { _id: id },
    result.delivered
      ? { $set: { deliveredAt: new Date() } }
      : { $set: { deliveryFailedAt: new Date(), supersededAt: new Date() } },
  );
  return result;
}

/**
 * Spends a reset token and sets the new password. The token is claimed with a
 * conditional update, so it works once even under concurrent submissions.
 * Every existing session for the account is revoked.
 */
export async function completePasswordReset(token: string, passwordHash: string): Promise<boolean> {
  const collection = await resets();
  const client = await getMongoClient();
  return client.withSession((dbSession) =>
    dbSession.withTransaction(async () => {
      const now = new Date();
      const claimed = await collection.findOneAndUpdate(
        { tokenHash: hashToken(token), usedAt: null, supersededAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
        { session: dbSession },
      );
      if (!claimed) return false;
      await updatePasswordHash(claimed.userId, passwordHash, dbSession);
      await revokeUserSessions(claimed.userId, dbSession);
      await collection.updateMany(
        { userId: claimed.userId, usedAt: null, supersededAt: null },
        { $set: { supersededAt: now } },
        { session: dbSession },
      );
      return true;
    }),
  );
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function resetEmailHtml(fullName: string, link: string) {
  return `<p>Hi ${escapeHtml(fullName)},</p>
<p>Use the button below to choose a new password for Farm Korect Nig. The link expires in 30 minutes and can be used once.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#004b2e;color:#ffffff;border-radius:999px;text-decoration:none;font-weight:600">Reset password</a></p>
<p>If you didn't ask to reset your password, ignore this email — your password won't change.</p>`;
}
