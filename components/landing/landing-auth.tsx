"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSession } from "@/lib/auth/api";
import { setOnboarded } from "@/lib/storage";
import { DESKTOP_QUERY } from "./splash";

/** Where a signed-in visitor goes ("/home" or "/farm-setup"), or null. */
let appHref: Promise<string | null> | null = null;

function readAppHref(): Promise<string | null> {
  // one request for every button on the page; the server reads the httpOnly cookie
  appHref ??= getSession().then(
    (res) => (res.ok ? (res.data.farmSetupComplete ? "/home" : "/farm-setup") : null),
    () => null,
  );
  return appHref;
}

/** Null when not signed in, not known yet, or below desktop (where the landing page is hidden). */
function useAppHref(): string | null {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    if (!window.matchMedia(DESKTOP_QUERY).matches) return;
    let cancelled = false;
    void readAppHref().then((next) => {
      if (!cancelled) setHref(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return href;
}

const SIZES = {
  md: "h-11 px-6 text-sm",
  lg: "h-12 px-7 text-base",
};

const base =
  "inline-flex items-center justify-center rounded-full font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-primary-dark";
const primary = "bg-highlight text-primary-dark hover:bg-highlight/85";
const secondary = "text-white ring-1 ring-white/30 hover:bg-white/10";

/**
 * The landing page's calls to action, styled for its dark green sections:
 * Create an account / Sign in for visitors, Open the app for someone already
 * signed in.
 */
export function LandingActions({ size = "md" }: { size?: keyof typeof SIZES }) {
  const href = useAppHref();
  const button = `${base} ${SIZES[size]}`;

  if (href) {
    return (
      <Link href={href} className={`${button} ${primary}`}>
        Open the app
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <Link href="/auth/choose-role" onClick={() => setOnboarded()} className={`${button} ${primary}`}>
        Create an account
      </Link>
      <Link href="/auth/sign-in" onClick={() => setOnboarded()} className={`${button} ${secondary}`}>
        Sign in
      </Link>
    </div>
  );
}
