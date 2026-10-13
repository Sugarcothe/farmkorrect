import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/auth/api";
import { clearOnboarding } from "@/lib/onboarding";

/**
 * Ends the session on the server (revoking it, not just dropping the cookie)
 * and only then leaves for the login screen; a failure keeps the user here
 * with the error.
 */
export function useSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    const res = await logout();
    if (!res.ok) {
      setPending(false);
      setError(res.error);
      return;
    }
    clearOnboarding();
    router.replace("/auth/sign-in");
    router.refresh();
  }

  return { signOut, pending, error };
}
