import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@/lib/auth/types";

// Sign-up flow progress, kept in sessionStorage so it survives reloads but not
// the tab. It only steers the UI between screens — the server must enforce
// verification itself. Never put passwords or OTP codes in here.
export type OnboardingState = {
  role?: Role;
  fullName?: string;
  /** E.164, e.g. +2348123456789 */
  phone?: string;
  /** set only after the server confirms the OTP */
  phoneVerified?: boolean;
  /** set only after the server saves the farm */
  setupComplete?: boolean;
};

const KEY = "fk.onboarding";
const CHANGE_EVENT = "fk-onboarding-change";

function readRaw(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function parse(raw: string): OnboardingState {
  try {
    return raw ? (JSON.parse(raw) as OnboardingState) : {};
  } catch {
    return {};
  }
}

export function updateOnboarding(patch: Partial<OnboardingState>) {
  try {
    const next = { ...parse(readRaw()), ...patch };
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (e.g. blocked); the flow guards will send the user back
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** null until hydrated on the client */
export function useOnboarding(): OnboardingState | null {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  return useMemo(() => (raw === null ? null : parse(raw)), [raw]);
}

/**
 * Returns the onboarding state once `allowed` passes; otherwise redirects to
 * `fallback` so screens can't be reached out of order.
 */
export function useOnboardingStep(
  allowed: (state: OnboardingState) => boolean,
  fallback: string,
): OnboardingState | null {
  const state = useOnboarding();
  const router = useRouter();
  const ready = state !== null;
  const isAllowed = ready && allowed(state);

  useEffect(() => {
    if (ready && !isAllowed) router.replace(fallback);
  }, [ready, isAllowed, fallback, router]);

  return isAllowed ? state : null;
}
