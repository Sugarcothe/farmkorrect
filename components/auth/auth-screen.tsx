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

/** Off-white mobile screen; a centred phone-sized card on tablet/desktop. */
export function AuthScreen({ backHref, topBar, centered, children }: AuthScreenProps) {
  return (
    <main className="bleed-top flex flex-1 flex-col bg-surface pt-[env(safe-area-inset-top)] md:mt-0 md:items-center md:justify-center md:bg-primary/5 md:p-8">
      <div className="flex w-full flex-1 flex-col bg-surface md:h-[min(880px,calc(100dvh-4rem))] md:max-w-[420px] md:flex-none md:overflow-y-auto md:rounded-[2.5rem] md:shadow-2xl md:shadow-primary/15">
        <header className="grid h-14 shrink-0 grid-cols-[3rem_1fr_3rem] items-center px-3">
          {backHref ? (
            <Link
              href={backHref}
              aria-label="Back"
              className="flex size-10 items-center justify-center rounded-full text-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon name="arrow-left" />
            </Link>
          ) : (
            <span />
          )}
          <div className="text-center text-sm font-semibold">{topBar}</div>
        </header>
        <div className="flex flex-1 flex-col px-6 pb-8">
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

export function ScreenHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mt-4 text-center">
      <h1 className="text-[1.625rem] leading-tight font-bold tracking-tight text-foreground">
        {title}
      </h1>
      {children && (
        <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
          {children}
        </p>
      )}
    </div>
  );
}

export function FormAlert({
  tone = "error",
  children,
}: {
  tone?: "error" | "success";
  children: ReactNode;
}) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
        isError
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-accent/25 bg-accent/8 text-primary"
      }`}
    >
      <Icon
        name={isError ? "alert-circle" : "check-circle"}
        className="mt-px size-[18px] shrink-0"
      />
      <div>{children}</div>
    </div>
  );
}

export function TextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
    </Link>
  );
}
