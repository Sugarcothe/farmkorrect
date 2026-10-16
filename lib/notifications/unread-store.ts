"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getUnreadCount } from "./api";

// One shared unread count for the bell and the nav dot. It's read from the
// server when the app opens, when the tab comes back into view (at most once
// a minute) and right after the user marks something read — no background
// polling. null means "not known yet" (or the last read failed).

const REFRESH_AFTER_MS = 60_000;

let count: number | null = null;
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Sets the count from a server response (e.g. after marking read). */
export function setUnreadCount(value: number) {
  count = value;
  fetchedAt = Date.now();
  emit();
}

export function refreshUnreadCount(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && count !== null && Date.now() - fetchedAt < REFRESH_AFTER_MS) return Promise.resolve();
  inflight = getUnreadCount()
    .then((result) => {
      if (result.ok) setUnreadCount(result.data.unreadCount);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUnreadCount(): number | null {
  const value = useSyncExternalStore(
    subscribe,
    () => count,
    () => null,
  );

  useEffect(() => {
    void refreshUnreadCount();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshUnreadCount();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return value;
}
