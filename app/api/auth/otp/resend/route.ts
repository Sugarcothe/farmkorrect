import {
  assertSameOrigin,
  clientIp,
  HttpError,
  ok,
  readJsonBody,
  route,
  tooManyRequests,
} from "@/lib/server/http";
import { issueChallenge, markChallengeDelivered, markChallengeUndelivered, otpMessage } from "@/lib/server/otp";
import { hit } from "@/lib/server/rate-limit";
import { getRequestSession } from "@/lib/server/sessions";
import { sendSms } from "@/lib/server/sms/termii";
import { parsePhone } from "@/lib/server/validation";

// Texts a fresh code to the account behind the pending session, retiring the
// previous one. A 45-second cooldown (matching the screen's countdown) and
// hourly per-number and per-IP caps limit SMS abuse.
export const POST = route("otp-resend", async (request) => {
  assertSameOrigin(request);
  const phone = parsePhone(await readJsonBody(request));

  const active = await getRequestSession(request);
  if (!active || active.session.kind !== "pending" || active.user.status !== "pending_verification")
    throw new HttpError(401, "Your verification session has expired. Log in again to get a new code.");
  if (active.user.phoneNormalized !== phone)
    throw new HttpError(400, "Go back and check your phone number.");

  const ip = clientIp(request);
  if (ip) {
    const perIp = await hit("otpSendsPerIp", ip);
    if (perIp.limited) throw tooManyRequests(perIp.retryAfterSeconds);
  }
  const perPhone = await hit("otpSendsPerPhone", phone);
  if (perPhone.limited)
    throw tooManyRequests(perPhone.retryAfterSeconds, "You've asked for too many codes. Please try again later.");

  const issued = await issueChallenge(active.user._id);
  if (issued.status === "cooldown")
    throw tooManyRequests(
      issued.retryAfterSeconds,
      `Please wait ${issued.retryAfterSeconds} seconds before asking for another code.`,
    );

  const delivery = await sendSms(phone, otpMessage(issued.code));
  if (!delivery.delivered) {
    await markChallengeUndelivered(issued.challengeId);
    throw new HttpError(502, "We couldn't send a new code. Please try again in a moment.");
  }
  await markChallengeDelivered(issued.challengeId);
  return ok(null);
});
