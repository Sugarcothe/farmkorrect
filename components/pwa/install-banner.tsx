"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { useInstallPrompt } from "@/lib/pwa/install";

// Only once the user is past sign-up or login — never over the splash,
// onboarding slides, auth forms or OTP entry.
const BANNER_ROUTES = new Set(["/success", "/home"]);
const SHOW_DELAY_MS = 2000;

// The only thing this banner stores: when the user last dismissed it.
const DISMISS_KEY = "fk.installBannerDismissedUntil";
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

function isDismissed() {
  try {
    return Number(window.localStorage.getItem(DISMISS_KEY)) > Date.now();
  } catch {
    return false;
  }
}

function rememberDismissal() {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_MS));
  } catch {
    // storage blocked: the banner just hides for this page view
  }
}

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground ${focusRing}`}
    >
      <Icon name="x" className="size-4.5" />
    </button>
  );
}

export function InstallBanner() {
  const pathname = usePathname();
  const { mode, install } = useInstallPrompt();
  const [due, setDue] = useState(false);
  const [iosHelp, setIosHelp] = useState(false);
  const [height, setHeight] = useState(0);
  const bannerRef = useRef<HTMLElement>(null);
  const installRef = useRef<HTMLButtonElement>(null);
  const helpHeadingRef = useRef<HTMLHeadingElement>(null);
  const helpWasOpen = useRef(false);

  // "unsupported" browsers get nothing rather than a button that can't work
  const offerable = mode === "native" || mode === "ios";
  const onBannerRoute = BANNER_ROUTES.has(pathname);
  const visible = due && offerable && onBannerRoute;

  // give the page a moment before offering anything
  useEffect(() => {
    if (!offerable || !onBannerRoute) return;
    const timer = setTimeout(() => setDue(!isDismissed()), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [offerable, onBannerRoute]);

  // reserve the banner's height at the end of the page so it never covers
  // the last controls on screen
  useEffect(() => {
    const el = bannerRef.current;
    if (!visible || !el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (iosHelp) helpHeadingRef.current?.focus();
    else if (helpWasOpen.current) installRef.current?.focus();
    helpWasOpen.current = iosHelp;
  }, [iosHelp]);

  if (!visible) return null;

  function dismiss() {
    rememberDismissal();
    setIosHelp(false);
    setDue(false);
  }

  async function handleInstall() {
    if (mode === "ios") {
      setIosHelp(true);
      return;
    }
    const outcome = await install();
    // "accepted" hides the banner (the prompt is spent) and the browser fires
    // `appinstalled` once it has actually installed the app
    if (outcome === "dismissed") dismiss();
  }

  return (
    <>
      <div aria-hidden="true" style={{ height }} className="shrink-0" />
      <aside
        ref={bannerRef}
        aria-label="Install Farm Korret Nig"
        onKeyDown={(e) => {
          if (e.key === "Escape" && iosHelp) setIosHelp(false);
        }}
        className="animate-fade-up fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:inset-x-auto md:right-6 md:bottom-6 md:w-[380px] md:p-0"
      >
        <div className="mx-auto max-w-md rounded-2xl border border-foreground/10 bg-white p-3.5 shadow-lg shadow-primary/15">
          {iosHelp ? (
            <div>
              <div className="flex items-start gap-3">
                <h2
                  ref={helpHeadingRef}
                  tabIndex={-1}
                  className="flex-1 pt-0.5 text-sm font-bold text-foreground outline-none"
                >
                  Add Farm Korret Nig to your Home Screen
                </h2>
                <CloseButton
                  label="Close instructions"
                  onClick={() => setIosHelp(false)}
                />
              </div>
              <ol className="mt-2.5 space-y-2.5 text-[0.8125rem] leading-snug text-foreground">
                <li className="flex gap-2.5">
                  <StepNumber n={1} />
                  <span>
                    Tap the{" "}
                    <Icon
                      name="share"
                      className="inline size-4 -translate-y-px text-accent"
                    />{" "}
                    <strong className="font-semibold">Share</strong> button in
                    Safari (in the toolbar, or under the ••• menu).
                  </span>
                </li>
                <li className="flex gap-2.5">
                  <StepNumber n={2} />
                  <span>
                    Choose{" "}
                    <Icon
                      name="plus-square"
                      className="inline size-4 -translate-y-px text-accent"
                    />{" "}
                    <strong className="font-semibold">Add to Home Screen</strong>
                    .
                  </span>
                </li>
                <li className="flex gap-2.5">
                  <StepNumber n={3} />
                  <span>
                    Tap <strong className="font-semibold">Add</strong> to
                    finish.
                  </span>
                </li>
              </ol>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <span className="relative size-12 shrink-0 overflow-hidden rounded-xl border border-foreground/10 bg-white">
                <Image src="/fk-logo.png" alt="" fill sizes="48px" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-foreground">
                  Farm Korret Nig
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  Install our app for quick access to your poultry farm tools.
                </p>
                <button
                  ref={installRef}
                  type="button"
                  onClick={handleInstall}
                  className={`mt-2.5 inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-dark ${focusRing}`}
                >
                  Install App
                </button>
              </div>
              <CloseButton label="Dismiss install banner" onClick={dismiss} />
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/8 text-[0.6875rem] font-bold text-primary"
    >
      {n}
    </span>
  );
}
