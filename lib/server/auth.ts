import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthConfig } from "./config";
import { findSession, isFullyAuthenticated, type ActiveSession } from "./sessions";

// Authorization for server-rendered pages (route handlers use
// getRequestSession from ./sessions). Every protected page and API operation
// checks the session itself; nothing relies on a redirect elsewhere or on
// flags in browser storage.

/** Session for the current page render (deduplicated per request). */
export const getPageSession = cache(async (): Promise<ActiveSession | null> => {
  const token = (await cookies()).get(getAuthConfig().cookieName)?.value;
  return findSession(token);
});

/** For server pages: the verified, signed-in account, or a redirect to login. */
export async function requireVerifiedPageSession(): Promise<ActiveSession> {
  const active = await getPageSession();
  if (!isFullyAuthenticated(active)) redirect("/auth/sign-in");
  return active;
}
