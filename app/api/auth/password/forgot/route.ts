import { after } from "next/server";
import {
  assertSameOrigin,
  clientIp,
  HttpError,
  ok,
  readJsonBody,
  route,
  tooManyRequests,
} from "@/lib/server/http";
import { sendPasswordReset } from "@/lib/server/password-reset";
import { hit } from "@/lib/server/rate-limit";
import { isSmsConfigured } from "@/lib/server/sms/termii";
import { findUserByIdentifier } from "@/lib/server/users";
import { parseIdentifier } from "@/lib/server/validation";

// Answers every well-formed request the same way, whether or not the account
// exists. The lookup and delivery run after the response is sent, so the
// response time doesn't give registered accounts away either.
export const POST = route("password-forgot", async (request) => {
  assertSameOrigin(request);
  const identifier = parseIdentifier(await readJsonBody(request));

  const ip = clientIp(request);
  if (ip) {
    const perIp = await hit("resetRequestsPerIp", ip);
    if (perIp.limited) throw tooManyRequests(perIp.retryAfterSeconds);
  }
  const perIdentifier = await hit("resetRequestsPerIdentifier", `${identifier.kind}:${identifier.value}`);
  if (perIdentifier.limited) throw tooManyRequests(perIdentifier.retryAfterSeconds);

  // with no SMS provider there is no channel to send a reset through at all
  // (this says nothing about any particular account)
  if (!isSmsConfigured())
    throw new HttpError(503, "Password reset isn't available right now. Please try again later.");

  after(async () => {
    try {
      const user = await findUserByIdentifier(identifier);
      if (user?.status === "active") await sendPasswordReset(user);
    } catch (error) {
      console.error(`[password-forgot] background send failed: ${error instanceof Error ? error.name : "unknown"}`);
    }
  });
  return ok(null);
});
