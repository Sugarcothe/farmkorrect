import type { RegisterResponse } from "@/lib/auth/types";
import {
  assertSameOrigin,
  clientIp,
  HttpError,
  ok,
  readJsonBody,
  route,
  sessionCookie,
  tooManyRequests,
} from "@/lib/server/http";
import { markChallengeDelivered, otpMessage } from "@/lib/server/otp";
import { hashPassword } from "@/lib/server/passwords";
import { hit } from "@/lib/server/rate-limit";
import { isSmsConfigured, sendSms } from "@/lib/server/sms/termii";
import { createPendingRegistration, discardPendingUser } from "@/lib/server/users";
import { parseRegistration } from "@/lib/server/validation";

// Creates an unverified account and texts its first verification code. The
// browser gets only a short-lived "pending" session cookie, which is good for
// verifying the phone and nothing else.
//
// If the SMS can't be sent, the just-created account is removed again and the
// request fails, so the user can simply submit the form again; a sign-up never
// "succeeds" without a code on its way.
export const POST = route("register", async (request) => {
  assertSameOrigin(request);
  const input = parseRegistration(await readJsonBody(request));

  const ip = clientIp(request);
  if (ip) {
    const perIp = await hit("registerPerIp", ip);
    if (perIp.limited) throw tooManyRequests(perIp.retryAfterSeconds);
  }
  const perPhone = await hit("registerPerPhone", input.phone);
  if (perPhone.limited) throw tooManyRequests(perPhone.retryAfterSeconds);

  if (!isSmsConfigured())
    throw new HttpError(
      503,
      "We can't send verification codes right now, so sign-up is unavailable. Please try again later.",
    );

  const passwordHash = await hashPassword(input.password);
  const pending = await createPendingRegistration(input, passwordHash);

  const delivery = await sendSms(input.phone, otpMessage(pending.code));
  if (!delivery.delivered) {
    await discardPendingUser(pending.userId);
    throw new HttpError(
      502,
      "We couldn't send a verification code to this number. Check the number and try again.",
    );
  }
  await markChallengeDelivered(pending.challengeId);

  const headers = new Headers({
    "Set-Cookie": sessionCookie(pending.session.token, pending.session.maxAgeSeconds),
  });
  return ok<RegisterResponse>({ phone: input.phone }, { status: 201, headers });
});
