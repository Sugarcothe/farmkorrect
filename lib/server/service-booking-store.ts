import "server-only";
import type { ObjectId } from "mongodb";
import type { ServiceBookingActor, ServiceBookingEvent } from "@/lib/services/marketplace";
import { getDb } from "./db";
import {
  COLLECTIONS,
  type ServiceBookingDoc,
  type ServiceBookingHistoryDoc,
  type ServiceDoc,
  type ServicePaymentDoc,
  type ServiceRefundDoc,
  type UserDoc,
} from "./models";
import { queueNotifications, syncServiceBookingNotifications } from "./notifications";

// Shared by the Other Services booking, payment, refund and ledger modules
// (docs/other-services.md), so none of them has to import another's internals.

export async function bookingCollections() {
  const db = await getDb();
  return {
    bookings: db.collection<ServiceBookingDoc>(COLLECTIONS.serviceBookings),
    payments: db.collection<ServicePaymentDoc>(COLLECTIONS.servicePayments),
    refunds: db.collection<ServiceRefundDoc>(COLLECTIONS.serviceRefunds),
    services: db.collection<ServiceDoc>(COLLECTIONS.services),
    users: db.collection<UserDoc>(COLLECTIONS.users),
  };
}

export const bookingHistoryItem = (
  event: ServiceBookingEvent,
  by: ServiceBookingActor,
  userId: ObjectId | null,
  at: Date,
  note: string | null = null,
): ServiceBookingHistoryDoc => ({ event, by, userId, at, note });

/**
 * Turns a booking's new history items into notifications once the change has
 * committed; every write that adds one also sets notifySyncAt, so the
 * notification job finishes it if this fails.
 */
export const notifyBooking = (bookingId: ObjectId) =>
  queueNotifications("service booking notifications", () => syncServiceBookingNotifications(bookingId));

/** Records that a booking needs a person to look at it (the first reason is kept). */
export async function flagBooking(bookingId: ObjectId, issue: string) {
  console.error(`[service-bookings] booking ${bookingId.toHexString()} needs review: ${issue}`);
  const { bookings } = await bookingCollections();
  await bookings.updateOne(
    { _id: bookingId, reviewIssue: null },
    { $set: { reviewIssue: issue, updatedAt: new Date() } },
  );
}

/** The booking's source in the ledger: its public reference. */
export const bookingLedgerSource = (booking: Pick<ServiceBookingDoc, "reference">) => ({
  sourceType: "service_booking" as const,
  sourceId: booking.reference,
});
