"use client";

import { useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import hatchingEgg from "./hatching-egg.json";

// lottie-web touches `document` when imported, so it only loads in the browser.
const Lottie = dynamic(() => import("lottie-react"), {
  ssr: false,
  loading: () => <div className="size-40" />,
});

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

export function ComingSoon({ firstName }: { firstName: string }) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className="flex flex-col items-center gap-4">
      <Lottie
        animationData={hatchingEgg}
        loop={!reducedMotion}
        autoplay={!reducedMotion}
        className="size-40"
        aria-hidden="true"
      />
      <div className="space-y-2">
        <span className="inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
          Coming soon
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          Your dashboard is hatching
        </h1>
        <p className="mx-auto max-w-xs text-sm text-foreground/60">
          Hi {firstName}, we&apos;re building your farm dashboard. Vets, market,
          training and finances will all live here soon.
        </p>
      </div>
    </div>
  );
}
