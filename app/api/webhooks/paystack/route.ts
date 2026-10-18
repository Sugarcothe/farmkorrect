import { MongoServerError } from "mongodb";
import { hashToken } from "@/lib/server/crypto";
import { getDb } from "@/lib/server/db";
import { clientIp, HttpError, ok, readLimitedBody, route, tooManyRequests } from "@/lib/server/http";
import { COLLECTIONS, type ProviderEventDoc } from "@/lib/server/models";
import { handleChargeEvent, PAYMENT_REFERENCE } from "@/lib/server/order-payments";
import { handleRefundEvent } from "@/lib/server/order-refunds";
import { handleTransferEvent, isTransferEvent } from "@/lib/server/payouts";
import { handleBookingChargeEvent, SERVICE_PAYMENT_REFERENCE } from "@/lib/server/service-payments";
import { handleBookingRefundEvent } from "@/lib/server/service-refunds";
import { isPaystackConfigured, isValidWebhookSignature, parseTransfer, type Json } from "@/lib/server/paystack";
import { hit } from "@/lib/server/rate-limit";

// Paystack's event notifications: transfer events settle payouts,
// charge.success settles an order or service booking payment and refund.*
// settles an order or booking refund. Charge and refund events are only a prompt: the payment or refund
// is then looked up with Paystack's API and checked against the order, so
// the event's own amounts are never trusted. The signature is checked on the exact raw bytes before anything
// is parsed; unsigned or tampered requests get 401 and change nothing.
// An event is recorded once applied, so a redelivery is acknowledged without
// being applied again (applying twice would be harmless anyway). If the
// database fails the response is 500, so Paystack retries.

const MAX_WEBHOOK_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export const POST = route("webhooks/paystack", async (request) => {
  const ip = clientIp(request);
  if (ip) {
    const limit = await hit("webhooksPerIp", ip);
    if (limit.limited) throw tooManyRequests(limit.retryAfterSeconds);
  }
  if (!isPaystackConfigured()) throw new HttpError(503, "Not configured.");

  const raw = await readLimitedBody(request, MAX_WEBHOOK_BYTES, "Too large.");
  if (!isValidWebhookSignature(raw, request.headers.get("x-paystack-signature")))
    throw new HttpError(401, "Invalid signature.");

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid payload.");
  }
  const event = isObject(payload) && typeof payload.event === "string" ? payload.event : "";
  const data = isObject(payload) && isObject(payload.data) ? payload.data : null;
  const kind = isTransferEvent(event)
    ? "transfer"
    : event === "charge.success"
      ? "charge"
      : event.startsWith("refund.")
        ? "refund"
        : null;
  if (!kind) return ok({ received: true });

  const events = (await getDb()).collection<ProviderEventDoc>(COLLECTIONS.providerEvents);
  const id = hashToken(raw.toString("utf8"));
  if (await events.findOne({ _id: id })) return ok({ received: true });

  let reference: string | null = null;
  if (kind === "transfer") {
    const transfer = data ? parseTransfer(data) : null;
    if (!transfer) {
      console.error(`[webhooks/paystack] ${event}: unexpected payload`);
      return ok({ received: true });
    }
    await handleTransferEvent(event, transfer);
    reference = transfer.reference;
  } else {
    // our payment reference: data.reference on a charge, data.transaction_reference on a refund
    const field = kind === "charge" ? "reference" : "transaction_reference";
    const value = data && typeof data[field] === "string" ? data[field] : "";
    if (SERVICE_PAYMENT_REFERENCE.test(value)) {
      // an Other Services booking payment (docs/other-services.md)
      if (kind === "charge") await handleBookingChargeEvent(value);
      else await handleBookingRefundEvent(value);
    } else {
      // events for payments made outside the Market aren't ours
      if (!PAYMENT_REFERENCE.test(value)) return ok({ received: true });
      if (kind === "charge") await handleChargeEvent(value);
      else await handleRefundEvent(value);
    }
    reference = value;
  }
  try {
    await events.insertOne({ _id: id, event, reference, receivedAt: new Date() });
  } catch (error) {
    // the same delivery was handled in parallel
    if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
  }
  return ok({ received: true });
});
