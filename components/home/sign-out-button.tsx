"use client";

import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/lib/use-sign-out";

export function SignOutButton() {
  const { signOut, pending, error } = useSignOut();

  return (
    <div className="w-full max-w-xs space-y-3">
      {error && <FormAlert>{error}</FormAlert>}
      <Button variant="outline" loading={pending} onClick={signOut}>
        {pending ? "Signing Out…" : "Sign Out"}
      </Button>
    </div>
  );
}
