import { getDb } from "@/lib/server/db";
import {
  COLLECTIONS,
  type FarmDoc,
  type OtpChallengeDoc,
  type PasswordResetDoc,
  type ServiceDoc,
  type SessionDoc,
  type UserDoc,
} from "@/lib/server/models";

/** Direct collection access for asserting on (and adjusting) stored state. */
export async function collections() {
  const db = await getDb();
  return {
    users: db.collection<UserDoc>(COLLECTIONS.users),
    sessions: db.collection<SessionDoc>(COLLECTIONS.sessions),
    otp: db.collection<OtpChallengeDoc>(COLLECTIONS.otpChallenges),
    resets: db.collection<PasswordResetDoc>(COLLECTIONS.passwordResets),
    farms: db.collection<FarmDoc>(COLLECTIONS.farms),
    services: db.collection<ServiceDoc>(COLLECTIONS.services),
  };
}

export async function userByPhone(phone: string) {
  return (await collections()).users.findOne({ phoneNormalized: phone });
}
