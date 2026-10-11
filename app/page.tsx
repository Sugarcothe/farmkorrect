"use client";

import Image from "next/image";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSession } from "@/lib/auth/api";
import { isOnboarded } from "@/lib/storage";

const SPLASH_DURATION_MS = 1800;

export default function Splash() {
  const router = useRouter();

  useEffect(() => {
    // ask the server (it reads the httpOnly cookie) while the splash shows
    const session = getSession();
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await session;
      if (cancelled) return;
      if (res.ok) {
        router.replace(res.data.farmSetupComplete ? "/home" : "/farm-setup");
      } else if (isOnboarded()) {
        router.replace("/auth/sign-in");
      } else {
        router.replace("/onboarding");
      }
    }, SPLASH_DURATION_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router]);

  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-accent via-primary to-primary-dark px-6">
      <div className="animate-fade-up flex flex-col items-center text-center">
        {/* the logo artwork has its own white margin, so it fills the tile */}
        <div className="relative size-28 overflow-hidden rounded-[1.75rem] bg-white shadow-xl shadow-black/25">
          <Image src="/fk-logo.png" alt="" fill sizes="112px" preload />
        </div>
        <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-white">
          Farm Korrect
        </h1>
        <p className="mt-1.5 text-sm font-medium text-white/70">
          Everything poultry, one app
        </p>
      </div>
    </main>
  );
}
