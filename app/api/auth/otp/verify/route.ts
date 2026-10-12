import type { VerifyOtpResponse } from "@/lib/auth/types";
import { findInitialFarm } from "@/lib/server/farms";
import { getMongoClient } from "@/lib/server/db";
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
import { checkCode, consumeChallenge } from "@/lib/server/otp";
import { hit } from "@/lib/server/rate-limit";
import { createSession, getRequestSession, revokeSessionToken, readSessionToken } from "@/lib/server/sessions";
import { activateUser } from "@/lib/server/users";
import { parseOtpCode, parsePhone } from "@/lib/server/validation";

const SESSION_EXPIRED =
  "Your verification session has expired. Log in again to get a new code.";

// Confirms the code texted to the phone of the account behind the pending
// session cookie. The phone in the body must match that account; the phone
// alone never identifies anyone. On success the account becomes active and
// the pending session is swapped for a full one (a new token, so a token seen
// before verification can't be reused afterwards).
export const POST = route("otp-verify", async (request) => {
  assertSameOrigin(request);
  const body = await readJsonBody(request);
  const phone = parsePhone(body);
  const code = parseOtpCode(body);

  const ip = clientIp(request);
  if (ip) {
    const perIp = await hit("otpVerifyPerIp", ip);
    if (perIp.limited) throw tooManyRequests(perIp.retryAfterSeconds);
  }

  const active = await getRequestSession(request);
  if (!active || active.session.kind !== "pending" || active.user.status !== "pending_verification")
    throw new HttpError(401, SESSION_EXPIRED);
  if (active.user.phoneNormalized !== phone)
    throw new HttpError(400, "This code wasn't sent to that number. Go back and check your phone number.");

  const result = await checkCode(active.user._id, code);
  switch (result.status) {
    case "incorrect":
      throw new HttpError(
        400,
        `That code isn't right. You have ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? "" : "s"} left.`,
      );
    case "expired":
      throw new HttpError(400, "This code has expired. Tap Resend Code to get a new one.");
    case "too_many_attempts":
      throw new HttpError(429, "Too many incorrect attempts. Tap Resend Code to get a new code.");
    case "no_challenge":
      throw new HttpError(400, "This code is no longer valid. Tap Resend Code to get a new one.");
  }

  const client = await getMongoClient();
  const session = await client.withSession((dbSession) =>
    dbSession.withTransaction(async () => {
      if (!(await consumeChallenge(result.challengeId, dbSession))) return null;
      if (!(await activateUser(active.user._id, dbSession))) return null;
      await revokeSessionToken(readSessionToken(request), dbSession);
      return createSession(active.user._id, "full", dbSession);
    }),
  );
  if (!session) throw new HttpError(400, "This code is no longer valid. Tap Resend Code to get a new one.");

  const next = (await findInitialFarm(active.user._id)) ? "home" : "farm-setup";
  const headers = new Headers({ "Set-Cookie": sessionCookie(session.token, session.maxAgeSeconds) });
  return ok<VerifyOtpResponse>({ next }, { headers });
});
