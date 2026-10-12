import { FarmSetupForm } from "@/components/farm/farm-setup-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";

// Every role sets up a farm profile after verifying their phone. Only a
// verified, signed-in session gets this far; everyone else goes to login.
export default async function FarmSetup() {
  await requireVerifiedPageSession();
  return <FarmSetupForm />;
}
