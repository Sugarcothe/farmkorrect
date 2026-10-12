import {
  assertSameOrigin,
  clearedSessionCookie,
  clientIp,
  HttpError,
  ok,
  readJsonBody,
  route,
  tooManyRequests,
} from "@/lib/server/http";
import { completePasswordReset } from "@/lib/server/password-reset";
import { hashPassword } from "@/lib/server/passwords";
import { hit } from "@/lib/server/rate-limit";
import { parsePasswordReset } from "@/lib/server/validation";

// Sets a new password using the single-use token from a reset link. All of the
// account's sessions are revoked, so the user logs in again with it.
export const POST = route("password-reset", async (request) => {
  assertSameOrigin(request);
  const ip = clientIp(request);
  if (ip) {
    const perIp = await hit("resetAttemptsPerIp", ip);
    if (perIp.limited) throw tooManyRequests(perIp.retryAfterSeconds);
  }

  const { token, password } = parsePasswordReset(await readJsonBody(request));
  const passwordHash = await hashPassword(password);
  if (!(await completePasswordReset(token, passwordHash)))
    throw new HttpError(400, "This reset link is invalid or has expired. Please request a new one.");

  return ok(null, { headers: new Headers({ "Set-Cookie": clearedSessionCookie() }) });
});
