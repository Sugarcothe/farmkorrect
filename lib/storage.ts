const ONBOARDED_KEY = "fk.onboarded";
const AUTHED_KEY = "fk.authed";
const PHONE_KEY = "fk.phone";

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(key);
}

function write(key: string, value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
}

export function isOnboarded(): boolean {
  return read(ONBOARDED_KEY) === "true";
}

export function setOnboarded() {
  write(ONBOARDED_KEY, "true");
}

export function isAuthed(): boolean {
  return read(AUTHED_KEY) === "true";
}

export function getPhone(): string | null {
  return read(PHONE_KEY);
}

export function signOut() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(AUTHED_KEY);
}
