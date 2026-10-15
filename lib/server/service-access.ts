import "server-only";
import type { Role } from "@/lib/auth/types";
import { offersServices } from "@/lib/services/config";
import { HttpError } from "./http";

export const SERVICES_UNVERIFIED = "Verify your phone number before managing your services.";

/** Refuses changes from a role that has no service categories. */
export function requireOfferingRole(role: Role) {
  if (!offersServices(role)) throw new HttpError(403, "Your account type can't list services yet.");
}
