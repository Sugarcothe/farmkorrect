import { notImplemented } from "@/lib/server/not-implemented";

// TODO(backend): accept LoginRequest, check the password hash and set an
// httpOnly session cookie on success. Respond with ApiResult.
export async function POST() {
  return notImplemented("Logging in");
}
