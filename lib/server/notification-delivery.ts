import "server-only";
import { ObjectId } from "mongodb";
import webpush, { WebPushError } from "web-push";
import { MANDATORY_CATEGORIES } from "@/lib/notifications/types";
import { getAuthConfig, getResendConfig, getTermiiConfig, getWebPushConfig } from "./config";
import { sendEmail } from "./email/resend";
import type { NotificationDeliveryDoc, NotificationDoc, PushSubscriptionDoc, UserDoc } from "./models";
import { channelAllowed, getPreferences, mayReceive, notificationCollections, sweepNotificationSync } from "./notifications";
import { sendSms, type DeliveryResult } from "./sms/termii";

// Sends the outbox: email, SMS and push deliveries created with each
// notification. Run by POST /api/internal/notifications/process, never
// inside a request that changed money and never inside a transaction.
//
//   pending ──claim──► sending ──► sent
//      ▲                  │
//      └── retryable_failure ◄┤ (429, 5xx, network; backoff with jitter)
//                         ├──► failed     (a permanent provider error)
//                         ├──► exhausted  (MAX_ATTEMPTS used up)
//                         └──► skipped    (channel off, not set up, unverified, stale)
//
// A claim is one atomic findOneAndUpdate, so two workers never hold the same
// delivery, and the outcome is only written by the worker whose claimToken
// still matches. A claim older than LEASE_MS (a crashed worker) is put back
// for retry. A delivery is "sent" only once the provider accepted it. If a
// worker dies after the provider accepted but before recording it, the
// retry may send it again: delivery is at-least-once, kept rare by the lease.
//
// Logs carry counts, states and failure categories only: never message text,
// email addresses, phone numbers, push endpoints or provider responses.

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 5 * 60_000;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;
/** An external message about something older than this isn't worth sending any more. */
export const STALE_AFTER_MS = 24 * 60 * 60_000;
const PARALLEL = 5;

/** Exponential backoff, capped, with jitter (50–100% of the step). */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(step * (0.5 + random() * 0.5));
}

/** 429, 5xx and network errors are worth retrying; other 4xx responses won't get better. */
export function isRetryable(reason: string): boolean {
  const match = /^http_(\d{3})$/.exec(reason);
  if (!match) return true;
  const status = Number(match[1]);
  return status === 429 || status >= 500 || status < 400;
}

type Outcome =
  | { state: "sent"; messageId: string | null }
  | { state: "skipped"; reason: string }
  | { state: "error"; reason: string };

// --- message content ----------------------------------------------------------------

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Absolute links are built only from APP_URL and the stored internal path. */
export function appLink(path: string | null): string {
  const origin = getAuthConfig().appOrigin;
  return `${origin}${path ?? "/notifications"}`;
}

export function notificationEmail(notification: Pick<NotificationDoc, "title" | "body" | "url" | "category">) {
  const link = appLink(notification.url);
  const settings = appLink("/profile/notifications");
  const footer = MANDATORY_CATEGORIES.includes(notification.category)
    ? "This is an account security notice, so it's always sent."
    : "You can choose which notifications you get in Profile → Notifications.";
  const text = `${notification.title}\n\n${notification.body}\n\nOpen Farm Korret Nig: ${link}\n\n${footer}\n${settings}`;
  const html = `<p style="font-size:16px;font-weight:600">${escapeHtml(notification.title)}</p>
<p>${escapeHtml(notification.body)}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#004b2e;color:#ffffff;border-radius:999px;text-decoration:none;font-weight:600">Open Farm Korret Nig</a></p>
<p style="color:#666666;font-size:13px">${escapeHtml(footer)} <a href="${escapeHtml(settings)}" style="color:#004b2e">Notification settings</a></p>`;
  return { subject: `${notification.title} — Farm Korret Nig`, text, html };
}

/** Short, with nothing sensitive: the title only (at most an order number). */
export const notificationSms = (notification: Pick<NotificationDoc, "title">) =>
  `Farm Korret: ${notification.title}. Open the app for details.`;

export function pushPayload(notification: Pick<NotificationDoc, "_id" | "title" | "body" | "url">) {
  return JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url ?? "/notifications",
    tag: notification._id.toHexString(),
  });
}

// --- sending ------------------------------------------------------------------------

const fromResult = (result: DeliveryResult): Outcome =>
  result.delivered
    ? result.messageId
      ? { state: "sent", messageId: result.messageId }
      : // accepted without a message id: nothing proves it was really sent
        { state: "error", reason: "no_message_id" }
    : result.reason === "not_configured"
      ? { state: "skipped", reason: "not_configured" }
      : { state: "error", reason: result.reason };

async function sendPush(notification: NotificationDoc, userId: ObjectId): Promise<Outcome> {
  const config = getWebPushConfig();
  if (!config) return { state: "skipped", reason: "not_configured" };
  const { pushSubscriptions } = await notificationCollections();
  const subscriptions = await pushSubscriptions.find({ userId }).limit(10).toArray();
  if (subscriptions.length === 0) return { state: "skipped", reason: "no_subscription" };

  const payload = pushPayload(notification);
  let sent = 0;
  let retryable: string | null = null;
  let permanent: string | null = null;
  for (const subscription of subscriptions) {
    const outcome = await pushOne(subscription, payload, config);
    if (outcome === "sent") {
      sent += 1;
      await pushSubscriptions.updateOne({ _id: subscription._id }, { $set: { lastSuccessAt: new Date() } });
    } else if (outcome === "gone") {
      // the browser unsubscribed or the subscription expired
      await pushSubscriptions.deleteOne({ _id: subscription._id, endpointHash: subscription.endpointHash });
    } else if (isRetryable(outcome)) retryable = outcome;
    else permanent = outcome;
  }
  if (sent > 0) return { state: "sent", messageId: null };
  if (retryable) return { state: "error", reason: retryable };
  if (permanent) return { state: "error", reason: permanent };
  return { state: "skipped", reason: "subscription_expired" };
}

async function pushOne(
  subscription: PushSubscriptionDoc,
  payload: string,
  config: NonNullable<ReturnType<typeof getWebPushConfig>>,
): Promise<"sent" | "gone" | string> {
  try {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
      TTL: 12 * 60 * 60,
      timeout: 10_000,
      urgency: "normal",
    });
    return "sent";
  } catch (error) {
    if (error instanceof WebPushError) {
      if (error.statusCode === 404 || error.statusCode === 410) return "gone";
      return `http_${error.statusCode}`;
    }
    return "network";
  }
}

type DeliveryUser = Pick<UserDoc, "_id" | "status" | "emailNormalized" | "phoneNormalized" | "emailVerifiedAt" | "phoneVerifiedAt">;

/** Re-checks everything at send time (preferences may have changed since it was queued), then sends. */
async function deliver(delivery: NotificationDeliveryDoc, now: Date): Promise<Outcome> {
  const { notifications, users } = await notificationCollections();
  const notification = await notifications.findOne({ _id: delivery.notificationId });
  if (!notification) return { state: "skipped", reason: "missing" };
  if (now.getTime() - notification.eventAt.getTime() > STALE_AFTER_MS) return { state: "skipped", reason: "stale" };
  const user: DeliveryUser | null = await users.findOne(
    { _id: delivery.recipientUserId },
    { projection: { _id: 1, status: 1, emailNormalized: 1, phoneNormalized: 1, emailVerifiedAt: 1, phoneVerifiedAt: 1 } },
  );
  if (!user || !mayReceive(user.status, notification.type)) return { state: "skipped", reason: "inactive" };
  const prefs = await getPreferences(user._id);
  if (!channelAllowed(prefs, notification.category, delivery.channel)) return { state: "skipped", reason: "channel_disabled" };

  switch (delivery.channel) {
    case "email": {
      if (getResendConfig() === null) return { state: "skipped", reason: "not_configured" };
      // never send account details to an address nobody has confirmed
      if (!user.emailVerifiedAt) return { state: "skipped", reason: "unverified" };
      return fromResult(await sendEmail({ to: user.emailNormalized, ...notificationEmail(notification) }));
    }
    case "sms": {
      // only real Termii delivery: never the development console or fixed-code modes
      if (getTermiiConfig() === null) return { state: "skipped", reason: "not_configured" };
      if (!user.phoneVerifiedAt) return { state: "skipped", reason: "unverified" };
      return fromResult(await sendSms(user.phoneNormalized, notificationSms(notification)));
    }
    case "push":
      return sendPush(notification, user._id);
  }
}

// --- claims -------------------------------------------------------------------------

/** Atomically takes the next due delivery; null when there's none. */
export async function claimDelivery(now = new Date()): Promise<NotificationDeliveryDoc | null> {
  const { deliveries } = await notificationCollections();
  return deliveries.findOneAndUpdate(
    { state: { $in: ["pending", "retryable_failure"] }, nextAttemptAt: { $lte: now } },
    { $set: { state: "sending", claimToken: new ObjectId(), claimedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
  );
}

/** Puts back deliveries whose worker stopped mid-send (or gives up on them). */
export async function recoverStaleClaims(now = new Date()): Promise<number> {
  const { deliveries } = await notificationCollections();
  const stale = { state: "sending" as const, claimedAt: { $lt: new Date(now.getTime() - LEASE_MS) } };
  const exhausted = await deliveries.updateMany(
    { ...stale, attempts: { $gte: MAX_ATTEMPTS } },
    {
      $set: { state: "exhausted", lastFailure: "interrupted", nextAttemptAt: null, claimToken: null, claimedAt: null, updatedAt: now },
    },
  );
  const retried = await deliveries.updateMany(stale, {
    $set: {
      state: "retryable_failure",
      lastFailure: "interrupted",
      nextAttemptAt: now,
      claimToken: null,
      claimedAt: null,
      updatedAt: now,
    },
  });
  return exhausted.modifiedCount + retried.modifiedCount;
}

export type FinalState = "sent" | "retryable_failure" | "failed" | "exhausted" | "skipped" | "lost";

/** Records the outcome, only if this worker still holds the claim. */
async function finish(delivery: NotificationDeliveryDoc, outcome: Outcome, now: Date): Promise<FinalState> {
  const { deliveries } = await notificationCollections();
  let $set: Partial<NotificationDeliveryDoc>;
  let state: FinalState;
  if (outcome.state === "sent") {
    state = "sent";
    $set = { state, providerMessageId: outcome.messageId, sentAt: now, lastFailure: null, nextAttemptAt: null };
  } else if (outcome.state === "skipped") {
    state = "skipped";
    $set = { state, lastFailure: outcome.reason, nextAttemptAt: null };
  } else if (!isRetryable(outcome.reason)) {
    state = "failed";
    $set = { state, lastFailure: outcome.reason, nextAttemptAt: null };
  } else if (delivery.attempts >= MAX_ATTEMPTS) {
    state = "exhausted";
    $set = { state, lastFailure: outcome.reason, nextAttemptAt: null };
  } else {
    state = "retryable_failure";
    $set = { state, lastFailure: outcome.reason, nextAttemptAt: new Date(now.getTime() + retryDelayMs(delivery.attempts)) };
  }
  const result = await deliveries.updateOne(
    { _id: delivery._id, state: "sending", claimToken: delivery.claimToken },
    { $set: { ...$set, claimToken: null, claimedAt: null, updatedAt: now } },
  );
  return result.modifiedCount === 1 ? state : "lost";
}

/** Sends one claimed delivery and records the result. */
export async function processDelivery(delivery: NotificationDeliveryDoc, now = new Date()): Promise<FinalState> {
  let outcome: Outcome;
  try {
    outcome = await deliver(delivery, now);
  } catch (error) {
    console.error(`[notifications] ${delivery.channel} delivery errored: ${error instanceof Error ? error.name : "unknown"}`);
    outcome = { state: "error", reason: "error" };
  }
  return finish(delivery, outcome, now);
}

export type NotificationJobResult = {
  synced: number;
  syncFailed: number;
  recovered: number;
  sent: number;
  retrying: number;
  failed: number;
  exhausted: number;
  skipped: number;
};

/**
 * One run of the notification job: finish any notifications still owed,
 * recover abandoned claims, then send up to `limit` due deliveries.
 */
export async function runNotificationJob({ limit = 25 }: { limit?: number } = {}): Promise<NotificationJobResult> {
  const now = new Date();
  const result: NotificationJobResult = {
    synced: 0,
    syncFailed: 0,
    recovered: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    exhausted: 0,
    skipped: 0,
  };
  const sweep = await sweepNotificationSync(limit, now);
  result.synced = sweep.synced;
  result.syncFailed = sweep.failed;
  result.recovered = await recoverStaleClaims(now);

  let remaining = limit;
  while (remaining > 0) {
    const batch: NotificationDeliveryDoc[] = [];
    while (batch.length < Math.min(PARALLEL, remaining)) {
      const claimed = await claimDelivery(new Date());
      if (!claimed) break;
      batch.push(claimed);
    }
    if (batch.length === 0) break;
    remaining -= batch.length;
    const states = await Promise.all(batch.map((delivery) => processDelivery(delivery, new Date())));
    for (const state of states) {
      if (state === "sent") result.sent += 1;
      else if (state === "retryable_failure") result.retrying += 1;
      else if (state === "failed") result.failed += 1;
      else if (state === "exhausted") result.exhausted += 1;
      else if (state === "skipped") result.skipped += 1;
    }
  }
  return result;
}
