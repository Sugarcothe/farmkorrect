import { notImplemented } from "@/lib/server/not-implemented";

// TODO(backend): accept ResendOtpRequest, rate-limit, and text a fresh OTP to
// the phone on the pending session. Respond with ApiResult.
export async function POST() {
  return notImplemented("Resending the code");
}
