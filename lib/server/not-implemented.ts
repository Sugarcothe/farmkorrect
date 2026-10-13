import type { ApiResult } from "@/lib/auth/types";

/**
 * Placeholder response for API routes whose backend (database, SMS/email
 * provider, session store) hasn't been connected yet. Returns 501 so the UI
 * shows an honest error instead of pretending the action succeeded.
 */
export function notImplemented(action: string) {
  const body: ApiResult = {
    ok: false,
    error: `${action} isn't available yet — the Farm Korret server hasn't been connected. Please try again later.`,
  };
  return Response.json(body, { status: 501 });
}