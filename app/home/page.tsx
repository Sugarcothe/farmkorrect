"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getPhone, signOut } from "@/lib/storage";

export default function Home() {
  const router = useRouter();
  const phone = getPhone();

  function handleSignOut() {
    signOut();
    router.replace("/auth/sign-in");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          You&apos;re in 🎉
        </h1>
        <p className="text-sm text-foreground/60">
          Signed in as {phone ?? "your account"}. The farm dashboard goes
          here next.
        </p>
      </div>
      <Button variant="outline" className="max-w-xs" onClick={handleSignOut}>
        Sign Out
      </Button>
    </main>
  );
}
