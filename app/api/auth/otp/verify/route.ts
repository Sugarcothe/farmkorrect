import { notImplemented } from "@/lib/server/not-implemented";

// TODO(backend): accept VerifyOtpRequest, check the code against the one sent
// for the pending session (with expiry and attempt limits) and mark the phone
// verified. Respond with ApiResult.
export async function POST() {
  return notImplemented("Phone verification");
}
