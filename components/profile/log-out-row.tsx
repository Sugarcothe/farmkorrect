"use client";

import { FormAlert } from "@/components/auth/auth-screen";
import { useSignOut } from "@/lib/use-sign-out";
import { MenuRowContent, menuRowClass } from "./profile-parts";

export function LogOutRow() {
  const { signOut, pending, error } = useSignOut();

  return (
    <>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        aria-busy={pending || undefined}
        className={menuRowClass}
      >
        <MenuRowContent icon="log-out" label={pending ? "Logging out…" : "Log Out"} danger />
      </button>
      {error && (
        <div className="px-4 pb-3">
          <FormAlert>{error}</FormAlert>
        </div>
      )}
    </>
  );
}
