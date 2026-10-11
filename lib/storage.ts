// Device preferences only. Whether someone is signed in is decided by the
// server from the httpOnly session cookie, never by anything stored here.
const ONBOARDED_KEY = "fk.onboarded";

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable; onboarding will simply show again
  }
}

export function isOnboarded(): boolean {
  return read(ONBOARDED_KEY) === "true";
}

export function setOnboarded() {
  write(ONBOARDED_KEY, "true");
}
