import { notImplemented } from "@/lib/server/not-implemented";

// TODO(backend): accept RegisterRequest, validate it server-side, hash the
// password, create the user with their role, text an OTP to the phone and set
// a pending-verification session cookie. Respond with ApiResult.
export async function POST() {
  return notImplemented("Account registration");
}
