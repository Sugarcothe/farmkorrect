"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/auth/api";
import { clearOnboarding } from "@/lib/onboarding";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
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

  return (
    <div className="w-full max-w-xs space-y-3">
      {error && <FormAlert>{error}</FormAlert>}
      <Button variant="outline" loading={pending} onClick={handleSignOut}>
        {pending ? "Signing Out…" : "Sign Out"}
      </Button>
    </div>
  );
}
