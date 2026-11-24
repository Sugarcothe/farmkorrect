import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icons";

type AuthScreenProps = {
  backHref?: string;
  /** small centred heading in the top bar, e.g. "OTP Verification" */
  topBar?: ReactNode;
  /** vertically centre short forms instead of starting them at the top */
  centered?: boolean;
  children: ReactNode;
};

const PILLARS: { icon: IconName; label: string }[] = [
  { icon: "store", label: "Poultry market" },
  { icon: "stethoscope", label: "Verified vets" },
  { icon: "wrench", label: "Farm services" },
  { icon: "graduation-cap", label: "Training" },
];

function BackButton({ href, className = "flex" }: { href: string; className?: string }) {
  return (
    <Link
      href={href}
      aria-label="Back"
      className={`size-10 items-center justify-center rounded-full text-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent ${className}`}
    >
      <Icon name="arrow-left" />
    </Link>
  );
}

/** Desktop only: the brand panel beside the form. */
function AuthAside() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[44%] max-w-[40rem] shrink-0 flex-col justify-between overflow-hidden bg-primary-dark p-10 text-white lg:flex xl:p-12">
      <Image src="/slide-2.jpg" alt="" fill sizes="44vw" className="object-cover opacity-30" />
      <div className="absolute inset-0 bg-gradient-to-b from-primary-dark/70 via-primary-dark/60 to-primary-dark" />
      <Link
        href="/"
        className="relative flex w-fit items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-highlight"
      >
        <span className="relative size-10 overflow-hidden rounded-xl bg-white">
          <Image src="/farm-korret-logo.png" alt="" fill sizes="40px" />
        </span>
        <span className="text-lg font-semibold">Farm Korret</span>
      </Link>
      <div className="relative">
        <p className="text-4xl leading-tight font-bold tracking-tight xl:text-5xl">
          Everything poultry,
          <br />
          <span className="text-highlight">one app.</span>
        </p>
        <p className="mt-4 max-w-md text-base leading-relaxed text-white/75">
          Buy and sell, book a vet or a farm specialist, and learn new skills, all from one account.
        </p>
        <ul className="mt-8 grid max-w-md grid-cols-2 gap-3">
          {PILLARS.map((p) => (
            <li
              key={p.label}
              className="flex items-center gap-2.5 rounded-2xl bg-white/8 px-3.5 py-3 text-sm font-medium ring-1 ring-white/10"
            >
              <Icon name={p.icon} className="size-[18px] text-highlight" />
              {p.label}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/**
 * Off-white mobile screen; a centred phone-sized card on tablet; on desktop a
 * split screen with the brand panel on the left and the form on the right.
 */
export function AuthScreen({ backHref, topBar, centered, children }: AuthScreenProps) {
  return (
    <main className="bleed-top flex flex-1 flex-col bg-surface pt-[env(safe-area-inset-top)] md:mt-0 md:items-center md:justify-center md:bg-primary/5 md:p-8 lg:flex-row lg:items-stretch lg:justify-start lg:bg-surface lg:p-0">
      <AuthAside />
      <div className="flex w-full flex-1 flex-col bg-surface md:h-[min(880px,calc(100dvh-4rem))] md:max-w-[420px] md:flex-none md:overflow-y-auto md:rounded-[2.5rem] md:shadow-2xl md:shadow-primary/15 lg:min-h-dvh lg:h-auto lg:max-w-none lg:flex-1 lg:overflow-visible lg:rounded-none lg:shadow-none">
        <header className="grid h-14 shrink-0 grid-cols-[3rem_1fr_3rem] items-center px-3 lg:h-16 lg:px-6">
          {backHref === "/onboarding" ? (
            // desktop has no onboarding carousel: "/" is the landing page there
            <>
              <BackButton href={backHref} className="flex lg:hidden" />
              <BackButton href="/" className="hidden lg:flex" />
            </>
          ) : backHref ? (
            <BackButton href={backHref} />
          ) : (
            <span />
          )}
          <div className="text-center text-sm font-semibold">{topBar}</div>
        </header>
        <div className="flex flex-1 flex-col px-6 pb-8 lg:mx-auto lg:w-full lg:max-w-[28rem] lg:px-0 lg:pb-12">
          {/* pb-14 offsets the top bar so the form looks centred on the screen */}
          {centered ? <div className="my-auto pb-14">{children}</div> : children}
        </div>
      </div>
    </main>
  );
}

export function BrandMark() {
  return (
    <div className="relative mx-auto size-24 overflow-hidden rounded-full bg-white shadow-sm ring-1 ring-primary/10">
      <Image src="/farm-korret-logo.png" alt="Farm Korret" fill sizes="96px" preload />
    </div>
  );
}

export function IconBadge({ icon }: { icon: IconName }) {
  return (
    <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/8 text-primary">
      <Icon name={icon} className="size-7" />
    </div>
  );
}

export function ScreenHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mt-4 text-center">
      <h1 className="text-[1.625rem] leading-tight font-bold tracking-tight text-foreground">{title}</h1>
      {children && <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{children}</p>}
    </div>
  );
}

export function FormAlert({ tone = "error", children }: { tone?: "error" | "success"; children: ReactNode }) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
        isError ? "border-red-200 bg-red-50 text-red-800" : "border-accent/25 bg-accent/8 text-primary"
      }`}
    >
      <Icon name={isError ? "alert-circle" : "check-circle"} className="mt-px size-[18px] shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
    </Link>
  );
}
