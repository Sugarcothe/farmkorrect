import { assertSameOrigin, clearedSessionCookie, ok, route } from "@/lib/server/http";
import { readSessionToken, revokeSessionToken } from "@/lib/server/sessions";

// Revokes the session server-side (so a copied cookie stops working too) and
// clears the cookie.
export const POST = route("logout", async (request) => {
  assertSameOrigin(request);
  await revokeSessionToken(readSessionToken(request));
  return ok(null, { headers: new Headers({ "Set-Cookie": clearedSessionCookie() }) });
});
