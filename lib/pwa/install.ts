import { useSyncExternalStore } from "react";

// Chromium-only event; not part of the TypeScript DOM lib
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
    appinstalled: Event;
  }
  interface Navigator {
    /** iOS Safari: true when launched from the home screen */
    standalone?: boolean;
  }
}

/**
 * - `native`: the browser handed us an install prompt (Chromium)
 * - `ios`: iOS Safari, which can only install via Share → Add to Home Screen
 * - `unsupported`: no install flow we can offer from the page
 * - `installed`: running as the installed app, or the browser confirmed install
 */
export type InstallMode = "native" | "ios" | "unsupported" | "installed";

type InstallState = {
  promptEvent: BeforeInstallPromptEvent | null;
  installed: boolean;
  standalone: boolean;
};

let state: InstallState = {
  promptEvent: null,
  installed: false,
  standalone: false,
};
const subscribers = new Set<() => void>();

function setState(patch: Partial<InstallState>) {
  state = { ...state, ...patch };
  subscribers.forEach((notify) => notify());
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true
  );
}

function isIosSafari() {
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS reports itself as a Mac
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // other iOS browsers share WebKit but add their own token
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|GSA|YaBrowser|DuckDuckGo/.test(
    ua,
  );
  return iOS && /Safari/.test(ua) && !otherBrowser;
}

// Listeners live for the whole page: beforeinstallprompt can fire before any
// component mounts, and a missed event isn't sent again until the next load.
if (typeof window !== "undefined") {
  state.standalone = isStandalone();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // show our banner instead of the mini-infobar
    setState({ promptEvent: event });
  });
  window.addEventListener("appinstalled", () => {
    setState({ promptEvent: null, installed: true });
  });
  window
    .matchMedia("(display-mode: standalone)")
    .addEventListener("change", () => setState({ standalone: isStandalone() }));
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

const getSnapshot = () => state;

/** `mode` is `null` during SSR and hydration, so nothing renders until the client knows. */
export function useInstallPrompt(): {
  mode: InstallMode | null;
  install: typeof promptInstall;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => null);
  if (!current) return { mode: null, install: promptInstall };

  let mode: InstallMode;
  if (current.installed || current.standalone) mode = "installed";
  else if (current.promptEvent) mode = "native";
  else if (isIosSafari()) mode = "ios";
  else mode = "unsupported";

  return { mode, install: promptInstall };
}

/**
 * Shows the browser's own install dialog. Must be called from a user gesture.
 * The event can only be used once, so it's cleared whatever the outcome.
 */
async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = state.promptEvent;
  if (!event) return "unavailable";
  setState({ promptEvent: null });
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}
