import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icons";
import { formatKobo } from "@/lib/wallet/money";
import type {
  EarningStatus,
  Payout,
  PayoutFailureReason,
  PayoutStatus,
  WalletTransaction,
} from "@/lib/wallet/types";

// Pieces shared by the Wallet screens. Every amount shown comes from the
// server's ledger; nothing here computes a balance.

export function formatDate(iso: string, withTime = false) {
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    timeZone: "Africa/Lagos",
  }).format(new Date(iso));
}

const STATUS: Record<EarningStatus | PayoutStatus, { label: string; tone: string }> = {
  awaiting_delivery: { label: "Awaiting delivery", tone: "bg-foreground/6 text-foreground/65" },
  pending: { label: "Pending", tone: "bg-amber-50 text-amber-800" },
  available: { label: "Available", tone: "bg-accent/12 text-primary" },
  under_review: { label: "Under review", tone: "bg-amber-50 text-amber-800" },
  refunded: { label: "Refunded", tone: "bg-foreground/6 text-foreground/65" },
  requested: { label: "Requested", tone: "bg-foreground/6 text-foreground/65" },
  processing: { label: "Processing", tone: "bg-amber-50 text-amber-800" },
  paid: { label: "Paid", tone: "bg-accent/12 text-primary" },
  failed: { label: "Failed", tone: "bg-red-50 text-red-700" },
};

export function StatusBadge({ status }: { status: EarningStatus | PayoutStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${tone}`}>{label}</span>
  );
}

export const FAILURE_REASONS: Record<PayoutFailureReason, string> = {
  provider_rejected: "Paystack couldn't send this transfer.",
  provider_failed: "The transfer failed at the bank.",
  provider_reversed: "The bank reversed the transfer.",
  not_found_at_provider: "The transfer couldn't be confirmed, so it was cancelled.",
  account_changed: "Your bank account was changed before it was sent.",
  transfers_misconfigured: "Payouts were temporarily unavailable.",
};

const TRANSACTION_ICONS: Record<WalletTransaction["type"], IconName> = {
  earning: "plus",
  platform_fee: "list",
  refund: "arrow-left",
  payout_hold: "landmark",
  payout_release: "arrow-left",
  payout_paid: "check-circle",
};

/** A ledger entry: credits in green with "+", debits with "−", internal moves plain. */
export function TransactionRow({ transaction: t }: { transaction: WalletTransaction }) {
  const sign = t.direction === "credit" ? "+" : t.direction === "debit" ? "−" : "";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
        <Icon name={TRANSACTION_ICONS[t.type]} className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{t.description}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{formatDate(t.createdAt, true)}</span>
          <span className="truncate font-mono text-[0.6875rem]">{t.reference}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span
          className={`text-sm font-semibold tabular-nums ${t.direction === "credit" ? "text-primary" : "text-foreground"}`}
        >
          {sign}
          {formatKobo(t.amountKobo)}
        </span>
        {t.status && <StatusBadge status={t.status} />}
      </div>
    </li>
  );
}

export function PayoutRow({ payout: p }: { payout: Payout }) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold tabular-nums">{formatKobo(p.amountKobo)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            To {p.bankName} ••••{p.accountNumberLast4} · {formatDate(p.requestedAt, true)}
          </p>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">{p.reference}</p>
        </div>
        <StatusBadge status={p.status} />
      </div>
      {p.status === "failed" && (
        <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs leading-relaxed text-red-800">
          {p.failureReason ? FAILURE_REASONS[p.failureReason] : "The transfer didn't go through."} The amount was returned
          to your available balance.
        </p>
      )}
      {(p.status === "requested" || p.status === "processing") && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Being sent. The amount stays set aside until the bank confirms it.
        </p>
      )}
      {p.status === "paid" && p.paidAt && (
        <p className="mt-2 text-xs text-muted-foreground">Paid {formatDate(p.paidAt, true)}</p>
      )}
    </li>
  );
}

export function ListCard({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
      {children}
    </ul>
  );
}

export function EmptyList({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-foreground/5">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/8 text-primary">
        <Icon name={icon} className="size-7" />
      </div>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/** "Newer" / "Older" links for paged lists. */
export function Pager({ newer, older }: { newer: string | null; older: string | null }) {
  if (!newer && !older) return null;
  const linkClass =
    "flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <nav aria-label="Pages" className="mt-4 flex justify-between">
      {newer ? (
        <Link href={newer} className={linkClass}>
          <Icon name="arrow-left" className="size-4" />
          Newer
        </Link>
      ) : (
        <span />
      )}
      {older && (
        <Link href={older} className={linkClass}>
          Older
          <Icon name="chevron-right" className="size-4" />
        </Link>
      )}
    </nav>
  );
}

/** Tabs between the wallet's lists. */
export function WalletTabs({ current }: { current: "transactions" | "earnings" | "payouts" }) {
  const tabs = [
    { key: "transactions", label: "Transactions", href: "/wallet/transactions" },
    { key: "earnings", label: "Earnings", href: "/wallet/earnings" },
    { key: "payouts", label: "Payouts", href: "/wallet/payouts" },
  ] as const;
  return (
    <nav aria-label="Wallet" className="mb-4 grid grid-cols-3 gap-1 rounded-full bg-foreground/5 p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? "page" : undefined}
          className={`flex h-9 items-center justify-center rounded-full text-[0.8125rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            tab.key === current ? "bg-white text-primary shadow-sm" : "text-foreground/60 hover:text-foreground"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export const first = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);
