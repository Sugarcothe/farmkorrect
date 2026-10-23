import "server-only";
import { createHash } from "node:crypto";
import { MongoServerError, ObjectId, type Collection, type Filter, type UpdateFilter } from "mongodb";
import {
  DEFAULT_PREFERENCES,
  EXTERNAL_CHANNELS,
  MANDATORY_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
  isNotificationCategory,
  safeInternalPath,
  type ChannelAvailability,
  type ExternalChannel,
  type Notification,
  type NotificationCategory,
  type NotificationFilter,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationType,
  type PreferencesResponse,
} from "@/lib/notifications/types";
import { getResendConfig, getTermiiConfig, getWebPushConfig } from "./config";
import { getDb, getMongoClient } from "./db";
import { HttpError } from "./http";
import { formatDay, formatSlot } from "@/lib/vets/schedule";
import {
  type AppointmentDoc,
  COLLECTIONS,
  type NotificationDeliveryDoc,
  type NotificationDoc,
  type NotificationPreferencesDoc,
  type OrderDoc,
  type OrderHistoryDoc,
  type PayoutAccountDoc,
  type PayoutDoc,
  type ProductDoc,
  type PushSubscriptionDoc,
  type ReviewDoc,
  type ServiceBookingDoc,
  type UserDoc,
} from "./models";

// The notification service. Notifications are only made here, on the
// server, from business events that are already stored:
//
//   1. A change that should notify someone (an order paid, a payout sent, a
//      review published…) sets `notifySyncAt` in the same atomic write as
//      the change itself — the transactional outbox. Orders and payouts also
//      append the event to their `history`.
//   2. After that write commits, the caller runs sync…Notifications(id).
//      It reads the stored record, works out who to tell from it (never from
//      the request), and writes the inbox entries plus one delivery row per
//      external channel. Then it clears `notifySyncAt`.
//   3. If step 2 fails or the process dies, the notification job finds the
//      record by its `notifySyncAt` and runs the same sync again.
//
// Each notification's eventKey (e.g. order:<id>:<history index>:paid) is
// unique per recipient, so a repeated webhook, a retry or a second sync can
// never notify anyone twice, and an unchanged status adds no history item,
// so it notifies no one. Nothing here runs inside a business transaction:
// a failure can only delay a notification, never undo a payment, refund or
// payout. Email, SMS and push are sent later by the job
// (lib/server/notification-delivery.ts), never inline.

export const NOTIFICATION_PAGE_SIZE = 20;

/** History older than this isn't turned into notifications (e.g. records from before notifications existed). */
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a record's notifySyncAt must have been set before the job picks it up. */
export const SYNC_GRACE_MS = 30_000;
const MAX_PUSH_SUBSCRIPTIONS = 10;

export async function notificationCollections() {
  const db = await getDb();
  return {
    notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
    deliveries: db.collection<NotificationDeliveryDoc>(COLLECTIONS.notificationDeliveries),
    preferences: db.collection<NotificationPreferencesDoc>(COLLECTIONS.notificationPreferences),
    pushSubscriptions: db.collection<PushSubscriptionDoc>(COLLECTIONS.pushSubscriptions),
    users: db.collection<UserDoc>(COLLECTIONS.users),
  };
}

/**
 * Runs a notification step after a business change has committed. It never
 * throws: a failure is logged (error name only, no content or contact
 * details) and the notification job finishes the work later.
 */
export async function queueNotifications(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      `[notifications] ${label} failed; the notification job will retry: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

// --- what each notification says ------------------------------------------------

type Subject = NotificationDoc["subject"];

/** A notification to create, worked out from a stored record. */
export type NotificationSpec = {
  recipientUserId: ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  url: string | null;
  eventKey: string;
  subject: Subject;
  eventAt: Date;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The inbox entries an order history item produces. Only the order number is
 * used: no amounts, names, addresses or phone numbers.
 */
export function orderEventSpecs(order: OrderDoc, index: number): NotificationSpec[] {
  const item: OrderHistoryDoc | undefined = order.history[index];
  if (!item) return [];
  const id = order._id.toHexString();
  const n = order.number;
  const buyer = (type: NotificationType, title: string, body: string) => ({
    recipientUserId: order.buyerUserId,
    url: `/orders/${id}`,
    type,
    title,
    body,
  });
  const seller = (type: NotificationType, title: string, body: string) => ({
    recipientUserId: order.sellerUserId,
    url: `/sales/${id}`,
    type,
    title,
    body,
  });
  const wasPaid = order.history.slice(0, index).some((h) => h.event === "paid");

  let made: Omit<NotificationSpec, "eventKey" | "subject" | "eventAt">[] = [];
  switch (item.event) {
    case "created":
      made = [buyer("order_placed", `Order ${n} placed`, "Complete payment to confirm your order with the seller.")];
      break;
    case "payment_failed":
      made = [
        buyer(
          "payment_failed",
          `Payment for ${n} didn't go through`,
          "You can try again from the order page while the order is still open.",
        ),
      ];
      break;
    case "paid":
      made = [
        buyer("payment_confirmed", `Payment confirmed for ${n}`, "Your payment was received and the seller has been told."),
        seller("sale_paid", `New paid order ${n}`, "Payment is confirmed. Accept the order to start preparing it."),
      ];
      break;
    case "processing":
      made = [buyer("order_accepted", `Order ${n} accepted`, "The seller has accepted your order and is preparing it.")];
      break;
    case "in_transit":
      made = [buyer("order_dispatched", `Order ${n} is on its way`, "The seller has sent your order.")];
      break;
    case "delivered":
      made = [
        buyer(
          "order_delivered",
          `Order ${n} delivered`,
          "The seller marked your order as delivered. If something's wrong, report it from the order page.",
        ),
      ];
      break;
    case "cancelled":
      if (item.by !== "buyer")
        made.push(
          buyer("order_cancelled", `Order ${n} cancelled`, "This order was cancelled. Any refund is shown on the order page."),
        );
      // the seller only hears about orders that were paid
      if (item.by !== "seller" && wasPaid)
        made.push(
          seller(
            "sale_cancelled",
            `Order ${n} cancelled`,
            item.by === "buyer" ? "The buyer cancelled this order. Don't send it." : "This order was cancelled. Don't send it.",
          ),
        );
      break;
    case "expired":
      made = [buyer("order_expired", `Order ${n} closed`, "It wasn't paid in time, so the order was closed.")];
      break;
    case "refund_requested":
      made = [buyer("refund_processing", `Refund started for ${n}`, "We'll let you know when it's complete.")];
      if (item.by !== "seller")
        made.push(seller("sale_refund_processing", `Refund started on ${n}`, "A refund to the buyer is being processed."));
      break;
    case "refund_processed":
      made = [
        buyer("refund_completed", `Refund completed for ${n}`, "Your bank may take a few days to show it."),
        seller("sale_refund_completed", `Refund completed on ${n}`, "The refund to the buyer is complete."),
      ];
      break;
    case "refund_failed":
      made = [
        buyer("refund_failed", `Refund for ${n} didn't go through`, "Check the order page for its current status."),
        seller("sale_refund_failed", `Refund on ${n} didn't go through`, "Check the order page for its current status."),
      ];
      break;
    case "late_payment_refunded":
      made = [
        buyer(
          "late_payment_returned",
          `Late payment returned for ${n}`,
          "A payment that arrived after the order closed has been refunded.",
        ),
      ];
      break;
    case "issue_reported":
      made = [seller("sale_issue_reported", `Problem reported on ${n}`, "The buyer reported a problem with this order.")];
      break;
    case "issue_closed":
      made = [
        buyer("issue_resolved", `Problem on ${n} closed`, "The problem you reported has been closed."),
        seller("sale_issue_resolved", `Problem on ${n} closed`, "The reported problem has been closed."),
      ];
      break;
    default:
      // payment_started, stock_released: nothing to tell anyone
      made = [];
  }
  return made.map((spec) => ({
    ...spec,
    eventKey: `order:${id}:${index}:${item.event}`,
    subject: { kind: "order", id },
    eventAt: item.at,
  }));
}

const PAYOUT_TEXT = {
  requested: ["payout_requested", "Payout requested", "We'll send it to your bank account shortly."],
  processing: ["payout_processing", "Payout on its way", "Your payout is being sent to your bank account."],
  paid: ["payout_paid", "Payout paid", "Your payout has been paid to your bank account."],
  failed: ["payout_failed", "Payout needs attention", "Your payout didn't go through. Check your payouts for details."],
} as const;

export function payoutEventSpecs(payout: PayoutDoc, index: number): NotificationSpec[] {
  const item = payout.history[index];
  if (!item) return [];
  const id = payout._id.toHexString();
  const [type, title, body] = PAYOUT_TEXT[item.status];
  return [
    {
      recipientUserId: payout.userId,
      type,
      title,
      body,
      url: "/wallet/payouts",
      eventKey: `payout:${id}:${index}:${item.status}`,
      subject: { kind: "payout", id },
      eventAt: item.at,
    },
  ];
}

/**
 * The seller hears about a published review once (keyed on the review, so a
 * restore after removal doesn't repeat it); the author hears about each
 * moderation decision. A moderation reason is internal and never sent.
 */
export function reviewEventSpecs(review: ReviewDoc, productName: string): NotificationSpec[] {
  const id = review._id.toHexString();
  const productId = review.productId.toHexString();
  const specs: NotificationSpec[] = [];
  const moderation = review.moderation;
  if (moderation) {
    const shown = review.status === "published";
    const removed = review.status === "rejected";
    if (shown || removed)
      specs.push({
        recipientUserId: review.reviewerUserId,
        type: shown ? "review_approved" : "review_removed",
        title: shown ? "Your review is published" : "Your review was removed",
        body: clip(
          shown
            ? `Your review of ${productName} is now shown on the product.`
            : `Your review of ${productName} was removed by moderation and isn't shown on the product.`,
          160,
        ),
        url: "/profile/reviews",
        eventKey: `review:${id}:moderation:${moderation.at.getTime()}`,
        subject: { kind: "review", id },
        eventAt: moderation.at,
      });
  }
  if (review.status !== "published") return specs;
  return [
    ...specs,
    {
      recipientUserId: review.sellerUserId,
      type: "review_published",
      title: `New ${review.rating}-star review`,
      body: clip(`A customer reviewed ${productName}.`, 160),
      url: `/market/${productId}#reviews`,
      eventKey: `review:${id}:${review.createdAt.getTime()}`,
      subject: { kind: "review", id },
      eventAt: review.createdAt,
    },
  ];
}

export function bankAccountEventSpecs(account: PayoutAccountDoc): NotificationSpec[] {
  if (!account.current || account.status !== "recipient_created") return [];
  const id = account._id.toHexString();
  const changed = account.replacedPrevious === true;
  return [
    {
      recipientUserId: account.ownerUserId,
      type: changed ? "bank_account_changed" : "bank_account_added",
      title: changed ? "Payout bank account changed" : "Payout bank account added",
      body: "Payouts will go to this account. If this wasn't you, reset your password straight away.",
      url: "/profile/bank-details",
      eventKey: `bank_account:${id}`,
      subject: { kind: "bank_account", id },
      eventAt: account.recipientCreatedAt ?? account.updatedAt,
    },
  ];
}

/**
 * The inbox entries an appointment history item produces: the other party
 * hears about each change. Only the service name, the time and the
 * reference: never the farm address or a phone number.
 */
export function appointmentEventSpecs(appointment: AppointmentDoc, index: number): NotificationSpec[] {
  const item = appointment.history[index];
  if (!item) return [];
  const id = appointment._id.toHexString();
  const when = formatSlot(appointment.startsAt.toISOString());
  const what = clip(appointment.service.name, 60);
  const url = `/appointments/${id}`;
  const spec = (recipientUserId: ObjectId, type: NotificationType, title: string, body: string): NotificationSpec => ({
    recipientUserId,
    type,
    title,
    body,
    url,
    eventKey: `appointment:${id}:${index}:${item.status}`,
    subject: { kind: "appointment", id },
    eventAt: item.at,
  });
  const customer = (type: NotificationType, title: string, body: string) =>
    spec(appointment.customerUserId, type, title, body);
  const vet = (type: NotificationType, title: string, body: string) => spec(appointment.vetUserId, type, title, body);
  switch (item.status) {
    case "requested":
      return [vet("appointment_requested", "New appointment request", `${what}, ${when}. Accept or decline it in Jobs.`)];
    case "confirmed":
      return [
        customer(
          "appointment_confirmed",
          appointment.paymentStatus === "not_required" ? "Appointment confirmed" : "Vet accepted your request",
          appointment.paymentStatus === "not_required"
            ? `${what}, ${when}.`
            : `${what}, ${when}. Payment isn't collected in the app.`,
        ),
      ];
    case "declined":
      return [customer("appointment_declined", "Appointment request declined", `${what}, ${when}. The time is free again.`)];
    case "cancelled":
      return item.by === "customer"
        ? [vet("appointment_cancelled", "Appointment cancelled", `The customer cancelled ${what}, ${when}.`)]
        : [customer("appointment_cancelled", "Appointment cancelled", `The vet cancelled ${what}, ${when}.`)];
    case "expired":
      return [
        customer("appointment_expired", "Request not answered", `The vet didn't respond in time to ${what}, ${when}.`),
        vet("appointment_expired", "Request lapsed", `You didn't respond in time to ${what}, ${when}.`),
      ];
    case "en_route":
      return [customer("appointment_en_route", "Vet on the way", `Your vet marked themselves on the way for ${what}.`)];
    case "in_progress":
      // only that it started: the vet's checklist and clinical notes are never part of a notification
      return [customer("appointment_started", "Visit started", `Your vet started ${what}.`)];
    case "completed":
      return [customer("appointment_completed", "Appointment completed", `${what} was marked completed by the vet.`)];
    default:
      return [];
  }
}

/**
 * The inbox entries a service booking history item produces: the other
 * party hears about each change. Only the service name, the booked day and
 * the reference: never the address, a phone number or the amount.
 */
export function serviceBookingEventSpecs(booking: ServiceBookingDoc, index: number): NotificationSpec[] {
  const item = booking.history[index];
  if (!item) return [];
  const id = booking._id.toHexString();
  const what = `${clip(booking.service.name, 60)} (${booking.reference})`;
  const when = formatDay(booking.schedule.date);
  const spec = (
    recipientUserId: ObjectId,
    url: string,
    type: NotificationType,
    title: string,
    body: string,
  ): NotificationSpec => ({
    recipientUserId,
    type,
    title,
    body,
    url,
    eventKey: `service_booking:${id}:${index}:${item.event}`,
    subject: { kind: "service_booking", id },
    eventAt: item.at,
  });
  const customer = (type: NotificationType, title: string, body: string) =>
    spec(booking.customerUserId, `/services/bookings/${id}`, type, title, body);
  const provider = (type: NotificationType, title: string, body: string) =>
    spec(booking.providerUserId, `/services/jobs/${id}`, type, title, body);
  switch (item.event) {
    case "requested":
      return [
        provider("service_booking_requested", "New service request", `${what} for ${when}. Respond in Service jobs.`),
      ];
    case "quote_offered":
      return [
        customer("service_booking_quote_offered", "You have a quote", `The provider priced ${what}. Accept it to pay.`),
      ];
    case "awaiting_payment":
      // only after a quote: a fixed-price booking starts here and nobody needs telling
      return booking.quote && item.by === "customer"
        ? [
            provider(
              "service_booking_quote_accepted",
              "Quote accepted",
              `The customer accepted your quote for ${what}.`,
            ),
          ]
        : [];
    case "paid":
      return [customer("service_booking_paid", "Payment received", `We received your payment for ${what}.`)];
    case "payment_failed":
      return [
        customer(
          "service_booking_payment_failed",
          "Payment didn't go through",
          `Your payment for ${what} failed. You can try again.`,
        ),
      ];
    case "confirmed":
      return item.by === "system"
        ? [provider("service_booking_confirmed", "Job confirmed", `The customer paid your quote for ${what}, ${when}.`)]
        : [customer("service_booking_confirmed", "Booking confirmed", `The provider accepted ${what}, ${when}.`)];
    case "declined":
      return [customer("service_booking_declined", "Booking declined", `The provider declined ${what}.`)];
    case "cancelled":
      return item.by === "customer"
        ? [provider("service_booking_cancelled", "Booking cancelled", `The customer cancelled ${what}.`)]
        : [customer("service_booking_cancelled", "Booking cancelled", `The provider cancelled ${what}.`)];
    case "expired":
      return [
        customer("service_booking_expired", "Booking lapsed", `${what} lapsed before it was confirmed.`),
        provider("service_booking_expired", "Booking lapsed", `${what} lapsed before it was confirmed.`),
      ];
    case "provider_en_route":
      return [customer("service_booking_en_route", "Provider on the way", `Your provider is on the way for ${what}.`)];
    case "in_progress":
      return [customer("service_booking_started", "Work started", `The provider started ${what}.`)];
    case "completed":
      return [customer("service_booking_completed", "Job completed", `${what} was marked completed by the provider.`)];
    case "refund_processed":
    case "late_payment_refunded":
      return [
        customer("service_booking_refund_processed", "Refund processed", `Your payment for ${what} was refunded.`),
      ];
    case "refund_failed":
      return [
        customer(
          "service_booking_refund_failed",
          "Refund delayed",
          `Your refund for ${what} needs attention. We're looking into it.`,
        ),
      ];
    default:
      // requested after payment is told to the provider above; nothing else to send
      return [];
  }
}

export function passwordChangedSpec(userId: ObjectId, resetId: ObjectId, at: Date): NotificationSpec {
  return {
    recipientUserId: userId,
    type: "password_changed",
    title: "Your password was changed",
    body: "If this wasn't you, reset your password again straight away.",
    url: "/profile",
    eventKey: `password:${resetId.toHexString()}`,
    subject: { kind: "account", id: userId.toHexString() },
    eventAt: at,
  };
}

// --- channels and preferences ---------------------------------------------------

type Recipient = Pick<UserDoc, "_id" | "status" | "emailVerifiedAt" | "phoneVerifiedAt">;

/** A config getter that throws on a malformed setting counts as "not set up" here. */
function configured(get: () => unknown, name: string): boolean {
  try {
    return get() !== null;
  } catch (error) {
    console.error(`[notifications] ${name} is misconfigured: ${error instanceof Error ? error.name : "unknown"}`);
    return false;
  }
}

/**
 * Whether each external channel can reach this user at all. Email needs a
 * verified address (none are verified yet, so email stays off); SMS needs a
 * verified phone and real Termii settings (never the development or
 * fixed-code modes); push needs VAPID keys and a subscribed browser.
 */
export async function channelAvailability(user: Recipient): Promise<Record<ExternalChannel, ChannelAvailability>> {
  const { pushSubscriptions } = await notificationCollections();
  const pushReady = configured(getWebPushConfig, "Web Push");
  const subscribed = pushReady && (await pushSubscriptions.countDocuments({ userId: user._id }, { limit: 1 })) > 0;
  return {
    email: !configured(getResendConfig, "Email")
      ? { available: false, note: "Email isn't set up yet." }
      : !user.emailVerifiedAt
        ? { available: false, note: "Needs a verified email address." }
        : { available: true, note: null },
    sms: !configured(getTermiiConfig, "SMS")
      ? { available: false, note: "SMS isn't set up yet." }
      : !user.phoneVerifiedAt
        ? { available: false, note: "Needs a verified phone number." }
        : { available: true, note: null },
    push: !pushReady
      ? { available: false, note: "Push notifications aren't set up yet." }
      : !subscribed
        ? { available: false, note: "Turn on push notifications on this device first." }
        : { available: true, note: null },
  };
}

function withDefaults(stored: Partial<NotificationPreferences> | undefined): NotificationPreferences {
  const out = {} as NotificationPreferences;
  for (const { value } of NOTIFICATION_CATEGORIES) {
    out[value] = { ...DEFAULT_PREFERENCES[value], ...stored?.[value] };
    // mandatory categories can't be turned off, whatever is stored
    if (MANDATORY_CATEGORIES.includes(value)) out[value] = { email: true, sms: true, push: true };
  }
  return out;
}

export async function getPreferences(userId: ObjectId): Promise<NotificationPreferences> {
  const { preferences } = await notificationCollections();
  const doc = await preferences.findOne({ _id: userId });
  return withDefaults(doc?.categories);
}

/** Whether a channel may be used for this category, by the user's choices. */
export function channelAllowed(prefs: NotificationPreferences, category: NotificationCategory, channel: ExternalChannel) {
  return MANDATORY_CATEGORIES.includes(category) || prefs[category][channel];
}

export async function getPreferencesResponse(user: Recipient): Promise<PreferencesResponse> {
  const [preferences, channels] = await Promise.all([getPreferences(user._id), channelAvailability(user)]);
  let pushPublicKey: string | null = null;
  try {
    pushPublicKey = getWebPushConfig()?.publicKey ?? null;
  } catch {
    pushPublicKey = null;
  }
  return { preferences, mandatory: [...MANDATORY_CATEGORIES], channels, pushPublicKey };
}

/**
 * Validates a PATCH body: any subset of { category: { channel: boolean } }.
 * Unknown keys and non-boolean values are rejected; mandatory categories
 * can't be switched off.
 */
export function parsePreferencesUpdate(body: Record<string, unknown>): Partial<NotificationPreferences> {
  const fieldErrors: Record<string, string> = {};
  const update: Partial<NotificationPreferences> = {};
  const keys = Object.keys(body);
  if (keys.length === 0) throw new HttpError(400, "Nothing to update.");
  for (const key of keys) {
    const value = body[key];
    if (!isNotificationCategory(key)) {
      fieldErrors[key] = "Unknown category.";
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fieldErrors[key] = "Expected channel settings.";
      continue;
    }
    const choices: Partial<Record<ExternalChannel, boolean>> = {};
    for (const [channel, on] of Object.entries(value)) {
      if (!(EXTERNAL_CHANNELS as readonly string[]).includes(channel)) {
        fieldErrors[`${key}.${channel}`] = "Unknown channel.";
      } else if (typeof on !== "boolean") {
        fieldErrors[`${key}.${channel}`] = "Must be true or false.";
      } else if (!on && MANDATORY_CATEGORIES.includes(key)) {
        fieldErrors[`${key}.${channel}`] = "Account security notices can't be turned off.";
      } else {
        choices[channel as ExternalChannel] = on;
      }
    }
    update[key] = choices as NotificationPreferences[NotificationCategory];
  }
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Check your notification settings.", fieldErrors);
  return update;
}

export async function updatePreferences(
  userId: ObjectId,
  update: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const { preferences } = await notificationCollections();
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [category, choices] of Object.entries(update)) {
    for (const [channel, on] of Object.entries(choices ?? {})) $set[`categories.${category}.${channel}`] = on;
  }
  await preferences.updateOne({ _id: userId }, { $set }, { upsert: true });
  return getPreferences(userId);
}

// --- creating notifications -----------------------------------------------------

/**
 * Writes the inbox entries and their pending deliveries. Each notification
 * and its delivery rows are written together in a small transaction of
 * their own (never the business change's), so a retry after a crash either
 * finds both or neither. Repeats are no-ops thanks to the unique
 * (recipient, eventKey) index. Returns how many notifications were new.
 */
export async function createNotifications(specs: NotificationSpec[], now = new Date()): Promise<number> {
  if (specs.length === 0) return 0;
  const { notifications, deliveries, users } = await notificationCollections();
  const client = await getMongoClient();
  const recipients = new Map<string, Recipient | null>();
  let created = 0;

  for (const spec of specs) {
    const key = spec.recipientUserId.toHexString();
    if (!recipients.has(key)) {
      recipients.set(
        key,
        await users.findOne(
          { _id: spec.recipientUserId },
          { projection: { _id: 1, status: 1, emailVerifiedAt: 1, phoneVerifiedAt: 1 } },
        ),
      );
    }
    const user = recipients.get(key);
    if (!user || !mayReceive(user.status, spec.type)) continue;

    const { category, channels } = NOTIFICATION_TYPES[spec.type];
    const [prefs, available] = await Promise.all([getPreferences(user._id), channelAvailability(user)]);
    const sendOn = (channels as readonly ExternalChannel[]).filter(
      (channel) => available[channel].available && channelAllowed(prefs, category, channel),
    );

    const doc: NotificationDoc = {
      _id: new ObjectId(),
      recipientUserId: spec.recipientUserId,
      type: spec.type,
      category,
      title: clip(spec.title, 120),
      body: clip(spec.body, 300),
      url: safeInternalPath(spec.url),
      eventKey: spec.eventKey,
      subject: spec.subject,
      eventAt: spec.eventAt,
      readAt: null,
      createdAt: now,
    };

    try {
      await client.withSession((session) =>
        session.withTransaction(async () => {
          const result = await notifications.updateOne(
            { recipientUserId: doc.recipientUserId, eventKey: doc.eventKey },
            { $setOnInsert: doc },
            { upsert: true, session },
          );
          if (!result.upsertedId) return;
          created += 1;
          if (sendOn.length === 0) return;
          await deliveries.insertMany(
            sendOn.map((channel) => ({
              _id: new ObjectId(),
              notificationId: doc._id,
              recipientUserId: doc.recipientUserId,
              channel,
              state: "pending" as const,
              attempts: 0,
              nextAttemptAt: now,
              claimToken: null,
              claimedAt: null,
              providerMessageId: null,
              lastFailure: null,
              sentAt: null,
              createdAt: now,
              updatedAt: now,
            })),
            { session },
          );
        }),
      );
    } catch (error) {
      // two syncs raced on the same event: the other one made it
      if (error instanceof MongoServerError && error.code === 11000) continue;
      throw error;
    }
  }
  return created;
}

const tooOld = (at: Date, now: Date) => now.getTime() - at.getTime() > MAX_EVENT_AGE_MS;

/**
 * Turns an order's new history items into notifications, then marks them
 * done. Safe to run any number of times, concurrently or after a crash.
 */
export async function syncOrderNotifications(orderId: ObjectId, now = new Date()): Promise<void> {
  const db = await getDb();
  const orders = db.collection<OrderDoc>(COLLECTIONS.orders);
  const order = await orders.findOne({ _id: orderId });
  if (!order || !order.notifySyncAt) return;
  const length = order.history.length;
  const specs: NotificationSpec[] = [];
  for (let i = order.notifiedThrough ?? 0; i < length; i++) {
    if (!tooOld(order.history[i].at, now)) specs.push(...orderEventSpecs(order, i));
  }
  await createNotifications(specs, now);
  await markSynced(orders, orderId, length);
}

export async function syncPayoutNotifications(payoutId: ObjectId, now = new Date()): Promise<void> {
  const db = await getDb();
  const payouts = db.collection<PayoutDoc>(COLLECTIONS.payouts);
  const payout = await payouts.findOne({ _id: payoutId });
  if (!payout || !payout.notifySyncAt) return;
  const length = payout.history.length;
  const specs: NotificationSpec[] = [];
  for (let i = payout.notifiedThrough ?? 0; i < length; i++) {
    if (!tooOld(payout.history[i].at, now)) specs.push(...payoutEventSpecs(payout, i));
  }
  await createNotifications(specs, now);
  await markSynced(payouts, payoutId, length);
}

export async function syncAppointmentNotifications(appointmentId: ObjectId, now = new Date()): Promise<void> {
  const db = await getDb();
  const appointments = db.collection<AppointmentDoc>(COLLECTIONS.appointments);
  const appointment = await appointments.findOne({ _id: appointmentId });
  if (!appointment || !appointment.notifySyncAt) return;
  const length = appointment.history.length;
  const specs: NotificationSpec[] = [];
  for (let i = appointment.notifiedThrough ?? 0; i < length; i++) {
    if (!tooOld(appointment.history[i].at, now)) specs.push(...appointmentEventSpecs(appointment, i));
  }
  await createNotifications(specs, now);
  await markSynced(appointments, appointmentId, length);
}

export async function syncServiceBookingNotifications(bookingId: ObjectId, now = new Date()): Promise<void> {
  const db = await getDb();
  const bookings = db.collection<ServiceBookingDoc>(COLLECTIONS.serviceBookings);
  const booking = await bookings.findOne({ _id: bookingId });
  if (!booking || !booking.notifySyncAt) return;
  const length = booking.history.length;
  const specs: NotificationSpec[] = [];
  for (let i = booking.notifiedThrough ?? 0; i < length; i++) {
    if (!tooOld(booking.history[i].at, now)) specs.push(...serviceBookingEventSpecs(booking, i));
  }
  await createNotifications(specs, now);
  await markSynced(bookings, bookingId, length);
}

/**
 * Clears the flag only if no history item was added meanwhile (a later
 * change keeps it set for the next sync); either way records how far the
 * history has been turned into notifications.
 */
async function markSynced<T extends OrderDoc | PayoutDoc | AppointmentDoc | ServiceBookingDoc>(collection: Collection<T>, id: ObjectId, length: number) {
  const cleared = await collection.updateOne(
    { _id: id, [`history.${length}`]: { $exists: false } } as Filter<T>,
    { $set: { notifySyncAt: null }, $max: { notifiedThrough: length } } as UpdateFilter<T>,
  );
  if (cleared.matchedCount === 0)
    await collection.updateOne({ _id: id } as Filter<T>, { $max: { notifiedThrough: length } } as UpdateFilter<T>);
}

export async function syncReviewNotification(reviewId: ObjectId, now = new Date()): Promise<void> {
  const db = await getDb();
  const reviews = db.collection<ReviewDoc>(COLLECTIONS.reviews);
  const review = await reviews.findOne({ _id: reviewId });
  if (!review || !review.notifySyncAt) return;
  const product = await db
    .collection<ProductDoc>(COLLECTIONS.products)
    .findOne({ _id: review.productId }, { projection: { name: 1 } });
  const specs = reviewEventSpecs(review, product?.name ?? "your product").filter((spec) => !tooOld(spec.eventAt, now));
  await createNotifications(specs, now);
  await reviews.updateOne({ _id: reviewId, notifySyncAt: review.notifySyncAt }, { $set: { notifySyncAt: null } });
}

/**
 * Notifications only reach active accounts, with one exception: the notice
 * that an account was suspended goes to that suspended account.
 */
export const mayReceive = (status: UserDoc["status"], type: NotificationType) =>
  status === "active" || (status === "suspended" && type === "account_suspended");

/**
 * The owner hears that their account was suspended or reactivated. Only the
 * latest change is notified, and never the admin's internal reason.
 */
export function accountStatusEventSpecs(user: Pick<UserDoc, "_id" | "suspension">): NotificationSpec[] {
  const change = user.suspension;
  if (!change) return [];
  const id = user._id.toHexString();
  const suspended = change.state === "suspended";
  return [
    {
      recipientUserId: user._id,
      type: suspended ? "account_suspended" : "account_reactivated",
      title: suspended ? "Your Farm Korret account is suspended" : "Your Farm Korret account is active again",
      body: suspended
        ? "Our team suspended your account, so you can't sign in for now. Contact Farm Korret support if you think this is a mistake."
        : "Our team reactivated your account. You can sign in again.",
      url: suspended ? null : "/auth/sign-in",
      eventKey: `account:${id}:${change.state}:${change.at.getTime()}`,
      subject: { kind: "account", id },
      eventAt: change.at,
    },
  ];
}

/** The professional hears the outcome of an admin's credential decision (not the internal reason). */
export function credentialEventSpecs(user: UserDoc): NotificationSpec[] {
  const status = user.profile?.credentialStatus;
  const at = user.profile?.credentialReviewedAt;
  if (!at || (status !== "verified" && status !== "rejected")) return [];
  const id = user._id.toHexString();
  const verified = status === "verified";
  return [
    {
      recipientUserId: user._id,
      type: verified ? "credential_verified" : "credential_rejected",
      title: verified ? "Credentials approved" : "Credentials not approved",
      body: verified
        ? "Our team reviewed the registration details you submitted and approved them."
        : "Our team couldn't approve the registration details you submitted. Check them in Edit Profile.",
      url: "/profile",
      eventKey: `credential:${id}:${at.getTime()}`,
      subject: { kind: "account", id },
      eventAt: at,
    },
  ];
}

export async function syncCredentialNotification(userId: ObjectId, now = new Date()): Promise<void> {
  const { users } = await notificationCollections();
  const user = await users.findOne({ _id: userId }, { projection: { profile: 1, suspension: 1, notifySyncAt: 1 } });
  if (!user || !user.notifySyncAt) return;
  await createNotifications(
    [...credentialEventSpecs(user), ...accountStatusEventSpecs(user)].filter((spec) => !tooOld(spec.eventAt, now)),
    now,
  );
  await users.updateOne({ _id: userId, notifySyncAt: user.notifySyncAt }, { $set: { notifySyncAt: null } });
}

export async function syncBankAccountNotification(accountId: ObjectId, now = new Date()): Promise<void> {
  const db = await getDb();
  const accounts = db.collection<PayoutAccountDoc>(COLLECTIONS.payoutAccounts);
  const account = await accounts.findOne({ _id: accountId });
  if (!account || !account.notifySyncAt) return;
  if (!tooOld(account.notifySyncAt, now)) await createNotifications(bankAccountEventSpecs(account), now);
  await accounts.updateOne({ _id: accountId, notifySyncAt: account.notifySyncAt }, { $set: { notifySyncAt: null } });
}

/** After a password reset has committed (best effort; the reset itself already succeeded). */
export async function notifyPasswordChanged(userId: ObjectId, resetId: ObjectId, at = new Date()): Promise<void> {
  await createNotifications([passwordChangedSpec(userId, resetId, at)], at);
}

/**
 * The job's sweep: re-runs the sync for records whose notifications were
 * never finished (a crash or a database error right after the change).
 */
export async function sweepNotificationSync(limit: number, now = new Date()) {
  const db = await getDb();
  const before = { $ne: null, $lte: new Date(now.getTime() - SYNC_GRACE_MS) };
  const ids = async (name: string) =>
    (
      await db
        .collection<{ _id: ObjectId; notifySyncAt?: Date | null }>(name)
        .find({ notifySyncAt: before }, { projection: { _id: 1 } })
        .sort({ notifySyncAt: 1 })
        .limit(limit)
        .toArray()
    ).map((doc) => doc._id);

  let synced = 0;
  let failed = 0;
  const run = async (list: ObjectId[], sync: (id: ObjectId, now: Date) => Promise<void>) => {
    for (const id of list) {
      try {
        await sync(id, now);
        synced += 1;
      } catch (error) {
        failed += 1;
        console.error(`[notifications] sync failed: ${error instanceof Error ? error.name : "unknown"}`);
      }
    }
  };
  await run(await ids(COLLECTIONS.orders), syncOrderNotifications);
  await run(await ids(COLLECTIONS.payouts), syncPayoutNotifications);
  await run(await ids(COLLECTIONS.reviews), syncReviewNotification);
  await run(await ids(COLLECTIONS.payoutAccounts), syncBankAccountNotification);
  await run(await ids(COLLECTIONS.users), syncCredentialNotification);
  await run(await ids(COLLECTIONS.appointments), syncAppointmentNotifications);
  await run(await ids(COLLECTIONS.serviceBookings), syncServiceBookingNotifications);
  return { synced, failed };
}

// --- the inbox ------------------------------------------------------------------

export function toNotification(doc: NotificationDoc): Notification {
  return {
    id: doc._id.toHexString(),
    type: doc.type,
    category: doc.category,
    title: doc.title,
    body: doc.body,
    url: safeInternalPath(doc.url),
    createdAt: doc.createdAt.toISOString(),
    readAt: doc.readAt?.toISOString() ?? null,
  };
}

export type InboxQuery = { filter: NotificationFilter; category: NotificationCategory | null; page: number };

export function parseInboxQuery(params: URLSearchParams): InboxQuery {
  const fieldErrors: Record<string, string> = {};
  const filter = params.get("filter") ?? "all";
  if (filter !== "all" && filter !== "unread") fieldErrors.filter = "Invalid filter.";
  const category = params.get("category");
  if (category !== null && !isNotificationCategory(category)) fieldErrors.category = "Invalid category.";
  const pageText = params.get("page");
  if (pageText !== null && !/^[1-9]\d{0,4}$/.test(pageText)) fieldErrors.page = "Invalid page.";
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Check the filters.", fieldErrors);
  return {
    filter: filter as NotificationFilter,
    category: (category as NotificationCategory | null) ?? null,
    page: pageText === null ? 1 : Number(pageText),
  };
}

export async function unreadCount(userId: ObjectId): Promise<number> {
  const { notifications } = await notificationCollections();
  return notifications.countDocuments({ recipientUserId: userId, readAt: null });
}

/** The user's own notifications, newest first. */
export async function listNotifications(userId: ObjectId, query: InboxQuery): Promise<NotificationPage> {
  const { notifications } = await notificationCollections();
  const filter: Record<string, unknown> = { recipientUserId: userId };
  if (query.filter === "unread") filter.readAt = null;
  if (query.category) filter.category = query.category;
  const [docs, count] = await Promise.all([
    notifications
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * NOTIFICATION_PAGE_SIZE)
      .limit(NOTIFICATION_PAGE_SIZE + 1)
      .toArray(),
    unreadCount(userId),
  ]);
  return {
    notifications: docs.slice(0, NOTIFICATION_PAGE_SIZE).map(toNotification),
    page: query.page,
    hasMore: docs.length > NOTIFICATION_PAGE_SIZE,
    unreadCount: count,
  };
}

/** Marks one of the user's own notifications read or unread; null if it isn't theirs or doesn't exist. */
export async function setRead(userId: ObjectId, id: ObjectId, read: boolean, now = new Date()) {
  const { notifications } = await notificationCollections();
  const doc = await notifications.findOneAndUpdate(
    { _id: id, recipientUserId: userId },
    [{ $set: { readAt: read ? { $ifNull: ["$readAt", now] } : null } }],
    { returnDocument: "after" },
  );
  return doc ? toNotification(doc) : null;
}

export async function markAllRead(userId: ObjectId, now = new Date()): Promise<number> {
  const { notifications } = await notificationCollections();
  const result = await notifications.updateMany({ recipientUserId: userId, readAt: null }, { $set: { readAt: now } });
  return result.modifiedCount;
}

// --- push subscriptions ---------------------------------------------------------

export const endpointHash = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");

export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

/** Validates a browser PushSubscription (as from subscription.toJSON()). */
export function parsePushSubscription(body: Record<string, unknown>): PushSubscriptionInput {
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(body)) {
    if (key !== "endpoint" && key !== "keys" && key !== "expirationTime") fieldErrors[key] = "Unknown field.";
  }
  const endpoint = body.endpoint;
  let endpointOk = false;
  if (typeof endpoint === "string" && endpoint.length <= 1000) {
    try {
      endpointOk = new URL(endpoint).protocol === "https:";
    } catch {
      endpointOk = false;
    }
  }
  if (!endpointOk) fieldErrors.endpoint = "Invalid push endpoint.";
  const keys = body.keys as Record<string, unknown> | undefined;
  const p256dh = keys && typeof keys === "object" ? keys.p256dh : undefined;
  const auth = keys && typeof keys === "object" ? keys.auth : undefined;
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{80,100}=*$/.test(p256dh)) fieldErrors["keys.p256dh"] = "Invalid key.";
  if (typeof auth !== "string" || !/^[A-Za-z0-9_-]{16,32}=*$/.test(auth)) fieldErrors["keys.auth"] = "Invalid key.";
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "That push subscription isn't valid.", fieldErrors);
  return { endpoint: endpoint as string, keys: { p256dh: p256dh as string, auth: auth as string } };
}

/**
 * Saves this browser's subscription for the signed-in user. A browser
 * re-subscribing under another account moves to that account. Each user
 * keeps at most MAX_PUSH_SUBSCRIPTIONS browsers; the oldest is dropped.
 */
export async function savePushSubscription(userId: ObjectId, input: PushSubscriptionInput, now = new Date()) {
  const { pushSubscriptions } = await notificationCollections();
  const hash = endpointHash(input.endpoint);
  await pushSubscriptions.updateOne(
    { endpointHash: hash },
    {
      $set: { userId, endpoint: input.endpoint, keys: input.keys, updatedAt: now },
      $setOnInsert: { _id: new ObjectId(), endpointHash: hash, lastSuccessAt: null, createdAt: now },
    },
    { upsert: true },
  );
  const extra = await pushSubscriptions
    .find({ userId }, { projection: { _id: 1 } })
    .sort({ updatedAt: -1 })
    .skip(MAX_PUSH_SUBSCRIPTIONS)
    .toArray();
  if (extra.length > 0) await pushSubscriptions.deleteMany({ _id: { $in: extra.map((s) => s._id) } });
}

/** Removes this browser's subscription, only if it belongs to the signed-in user. */
export async function removePushSubscription(userId: ObjectId, endpoint: string): Promise<boolean> {
  const { pushSubscriptions } = await notificationCollections();
  const result = await pushSubscriptions.deleteOne({ endpointHash: endpointHash(endpoint), userId });
  return result.deletedCount > 0;
}

export const NOTIFICATIONS_UNVERIFIED = "Verify your phone number to see your notifications.";
