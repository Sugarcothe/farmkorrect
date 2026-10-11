import { notImplemented } from "@/lib/server/not-implemented";

// TODO(backend): accept PasswordResetRequest and send reset instructions by
// email or SMS. Respond with ok: true whether or not the account exists, so
// the endpoint can't be used to discover registered users.
export async function POST() {
  return notImplemented("Password reset");
}
