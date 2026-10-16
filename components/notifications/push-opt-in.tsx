"use client";

import { useEffect, useState } from "react";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { removePushSubscription, savePushSubscription } from "@/lib/notifications/api";

type State = "checking" | "unsupported" | "blocked" | "off" | "on";

// Turns this browser into a push notification target, only when the user
// presses the button (the browser then asks for permission). Nothing is
// subscribed automatically. The server only stores the subscription once it
// has accepted it; "on" is shown only after that.

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const supported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration() {
  // the PWA registers /sw.js in production; reuse it rather than a second worker
  return (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

export function PushOptIn({ publicKey, onChanged }: { publicKey: string | null; onChanged: () => void }) {
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!supported()) return "unsupported" as const;
      if (Notification.permission === "denied") return "blocked" as const;
      const reg = await registration();
      if (!reg) return "unsupported" as const;
      return (await reg.pushManager.getSubscription()) ? ("on" as const) : ("off" as const);
    }
    check()
      .catch(() => "unsupported" as const)
      .then((next) => {
        if (!cancelled) setState(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!publicKey) return null;

  async function turnOn() {
    if (busy || !publicKey) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const reg = await registration();
      if (!reg) {
        setState("unsupported");
        return;
      }
      const subscription =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      const result = await savePushSubscription(subscription.toJSON());
      if (!result.ok) {
        await subscription.unsubscribe().catch(() => false);
        setError(result.error);
        return;
      }
      setState("on");
      onChanged();
    } catch {
      setError("This browser couldn't turn on notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await registration();
      const subscription = reg ? await reg.pushManager.getSubscription() : null;
      if (subscription) {
        const result = await removePushSubscription(subscription.endpoint);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        await subscription.unsubscribe().catch(() => false);
      }
      setState("off");
      onChanged();
    } catch {
      setError("This browser couldn't turn off notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const text: Record<State, string> = {
    checking: "Checking this browser…",
    unsupported: "This browser can't receive push notifications. On a phone, add Farm Korret to your home screen first.",
    blocked: "Notifications are blocked for this site. Allow them in your browser settings to turn this on.",
    off: "Get alerts on this device even when the app is closed.",
    on: "This device receives push notifications.",
  };

  return (
    <section aria-labelledby="push-title" className="rounded-3xl bg-white px-4 py-4 shadow-sm ring-1 ring-foreground/5">
      <h2 id="push-title" className="text-sm font-semibold">
        Push on this device
      </h2>
      <p className="mt-0.5 text-xs leading-snug text-muted-foreground" aria-live="polite">
        {text[state]}
      </p>
      {error && (
        <div className="mt-3">
          <FormAlert>{error}</FormAlert>
        </div>
      )}
      {state === "off" && (
        <Button className="mt-3" onClick={() => void turnOn()} loading={busy}>
          Turn on push notifications
        </Button>
      )}
      {state === "on" && (
        <Button variant="outline" className="mt-3" onClick={() => void turnOff()} loading={busy}>
          Turn off on this device
        </Button>
      )}
    </section>
  );
}
