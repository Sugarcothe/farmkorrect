import type { LoginResponse } from "@/lib/auth/types";
import { findInitialFarm } from "@/lib/server/farms";
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
import { issueChallenge, markChallengeDelivered, markChallengeUndelivered, otpMessage } from "@/lib/server/otp";
import { burnPasswordCheck, verifyPassword } from "@/lib/server/passwords";
import { hit, peek, reset } from "@/lib/server/rate-limit";
import { createSession, readSessionToken, revokeSessionToken } from "@/lib/server/sessions";
import { sendSms } from "@/lib/server/sms/termii";
import { findUserByIdentifier } from "@/lib/server/users";
import { parseLogin } from "@/lib/server/validation";

const BAD_CREDENTIALS = "Incorrect email/phone number or password.";
const ACCOUNT_SUSPENDED = "This account is suspended. Contact Farm Korret support if you think this is a mistake.";

// Password login by email or phone. Wrong passwords and unknown accounts get
// the same message and take the same time. Failures are counted per account
// and per IP; once either is over its limit, logins are refused until the
// window passes.
//
// Every successful login starts a brand-new session (and revokes the one the
// browser had), so a session id can't be planted before login. Accounts that
// never verified their phone only get a "pending" session and a fresh code.
// Suspended accounts get no session at all.
export const POST = route("login", async (request) => {
  assertSameOrigin(request);
  const input = parseLogin(await readJsonBody(request));
  const accountKey = `${input.kind}:${input.value}`;
  const ip = clientIp(request);

  const accountLimit = await peek("loginFailuresPerAccount", accountKey);
  if (accountLimit.limited) throw tooManyRequests(accountLimit.retryAfterSeconds);
  if (ip) {
    const ipLimit = await peek("loginFailuresPerIp", ip);
    if (ipLimit.limited) throw tooManyRequests(ipLimit.retryAfterSeconds);
  }

  const user = await findUserByIdentifier(input);
  const valid = user
    ? await verifyPassword(user.passwordHash, input.password)
    : (await burnPasswordCheck(input.password), false);

  if (!user || !valid) {
    await hit("loginFailuresPerAccount", accountKey);
    if (ip) await hit("loginFailuresPerIp", ip);
    throw new HttpError(401, BAD_CREDENTIALS);
  }
  await reset("loginFailuresPerAccount", accountKey);
  await revokeSessionToken(readSessionToken(request));

  // only said after the right password, so it doesn't reveal which accounts are suspended
  if (user.status === "suspended") throw new HttpError(403, ACCOUNT_SUSPENDED);

  if (user.status === "pending_verification") {
    const issued = await issueChallenge(user._id);
    // inside the cooldown the code sent moments ago is still valid
    if (issued.status === "issued") {
      const perPhone = await hit("otpSendsPerPhone", user.phoneNormalized);
      if (perPhone.limited) {
        await markChallengeUndelivered(issued.challengeId);
        throw tooManyRequests(perPhone.retryAfterSeconds, "You've asked for too many codes. Please try again later.");
      }
      const delivery = await sendSms(user.phoneNormalized, otpMessage(issued.code));
      if (!delivery.delivered) {
        await markChallengeUndelivered(issued.challengeId);
        throw new HttpError(
          502,
          "Your phone number still needs verifying, but we couldn't send a code. Please try again in a moment.",
        );
      }
      await markChallengeDelivered(issued.challengeId);
    }
    const pending = await createSession(user._id, "pending");
    const headers = new Headers({ "Set-Cookie": sessionCookie(pending.token, pending.maxAgeSeconds) });
    return ok<LoginResponse>(
      { next: "verify", phone: user.phoneNormalized, fullName: user.fullName },
      { headers },
    );
  }

  const session = await createSession(user._id, "full");
  const next = (await findInitialFarm(user._id)) ? "home" : "farm-setup";
  const headers = new Headers({ "Set-Cookie": sessionCookie(session.token, session.maxAgeSeconds) });
  return ok<LoginResponse>({ next }, { headers });
});
