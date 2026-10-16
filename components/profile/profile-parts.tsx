import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icons";
import type { CredentialStatus } from "@/lib/profile/types";

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
}

/** The user's photo, or their initials when they haven't added one. */
export function ProfileAvatar({
  photoUrl,
  name,
  className = "size-24 text-2xl",
}: {
  photoUrl: string | null;
  name: string;
  className?: string;
}) {
  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 font-semibold text-primary ring-4 ring-white ${className}`}
    >
      {photoUrl ? (
        // served only to its signed-in owner, so the image optimizer can't fetch it
        <Image src={photoUrl} alt="" fill sizes="96px" unoptimized className="object-cover" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </div>
  );
}

const CREDENTIAL_BADGES: Record<CredentialStatus, { label: string; icon: IconName; tone: string }> = {
  verified: { label: "Credentials verified", icon: "shield-check", tone: "bg-accent/12 text-primary" },
  pending: { label: "Verification pending", icon: "clock", tone: "bg-amber-100 text-amber-800" },
  rejected: { label: "Verification unsuccessful", icon: "alert-circle", tone: "bg-red-50 text-red-700" },
  not_submitted: { label: "Not yet verified", icon: "alert-circle", tone: "bg-foreground/6 text-foreground/60" },
};

/**
 * Professionals: the review status of their registration number.
 * Everyone else: their phone, which every signed-in account has verified.
 */
export function VerificationBadge({ credential }: { credential: CredentialStatus | null }) {
  const badge = credential
    ? CREDENTIAL_BADGES[credential]
    : { label: "Phone verified", icon: "shield-check" as const, tone: "bg-accent/12 text-primary" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${badge.tone}`}>
      <Icon name={badge.icon} className="size-3.5" />
      {badge.label}
    </span>
  );
}

/** Top bar for profile sub-pages; `back` is usually a <BackLink>. */
/** `action` is an optional control for the right-hand slot (e.g. the notifications bell). */
export function ProfileTopBar({ title, back, action }: { title: string; back?: ReactNode; action?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 grid h-14 shrink-0 grid-cols-[3rem_1fr_3rem] items-center bg-surface/95 px-3 backdrop-blur">
      {back ?? <span />}
      <h1 className="text-center text-base font-semibold">{title}</h1>
      {action && <div className="flex justify-end">{action}</div>}
    </header>
  );
}

export function BackLink({ href }: { href: string }) {
  return (
    <Link href={href} aria-label="Back" className={backButtonClass}>
      <Icon name="arrow-left" />
    </Link>
  );
}

export const backButtonClass =
  "flex size-10 items-center justify-center rounded-full outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent";

export function MenuRowContent({ icon, label, soon, danger }: { icon: IconName; label: string; soon?: boolean; danger?: boolean }) {
  return (
    <>
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${
          danger ? "bg-red-50 text-red-600" : "bg-primary/8 text-primary"
        }`}
      >
        <Icon name={icon} className="size-[18px]" />
      </span>
      <span className={`flex-1 text-[0.9375rem] font-medium ${danger ? "text-red-600" : "text-foreground"}`}>{label}</span>
      {soon && (
        <span className="rounded-full bg-foreground/6 px-2 py-0.5 text-[0.6875rem] font-semibold text-foreground/50">Soon</span>
      )}
      {!danger && <Icon name="chevron-right" className="size-[18px] text-foreground/35" />}
    </>
  );
}

export const menuRowClass =
  "flex w-full items-center gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset disabled:opacity-60";
