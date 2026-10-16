import { createHash, timingSafeEqual } from "node:crypto";
import { getNotificationJobSecret } from "@/lib/server/config";
import { HttpError, ok, route } from "@/lib/server/http";
import { runNotificationJob } from "@/lib/server/notification-delivery";

// Called by a scheduler (e.g. a cron job every 1–2 minutes) with an
// "Authorization: Bearer <NOTIFICATION_JOB_SECRET>" header: creates any
// notifications still owed for recorded events, recovers abandoned sends and
// sends a bounded batch of queued email, SMS and push deliveries. Returns
// counts only. Not reachable at all while NOTIFICATION_JOB_SECRET is unset.

const digest = (value: string) => createHash("sha256").update(value).digest();

export const POST = route("internal/notifications/process", async (request) => {
  const secret = getNotificationJobSecret();
  if (!secret) throw new HttpError(404, "Not found.");
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // compared as fixed-length digests, in constant time
  if (!given || !timingSafeEqual(digest(given), digest(secret))) throw new HttpError(401, "Not authorized.");
  return ok(await runNotificationJob());
});
