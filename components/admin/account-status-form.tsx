"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { changeAccountStatus } from "@/lib/admin/api";
import { ADMIN_TEXT_LIMITS } from "@/lib/admin/types";
import { validateAdminReason } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";

/**
 * Suspends or reactivates an account, with an internal reason and an
 * explicit confirmation. The change is made against the account version
 * the page was loaded at. Success is only shown once the server confirms.
 */
export function AccountStatusForm({
  userId,
  action,
  expectedVersion,
}: {
  userId: string;
  action: "suspend" | "reactivate";
  expectedVersion: number;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const suspend = action === "suspend";
  const reasonError = validateAdminReason(cleanText(reason, true));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (reasonError || !confirmed) return;
    setBusy(true);
    setError(null);
    const res = await changeAccountStatus(userId, {
      action,
      reason: cleanText(reason, true),
      expectedVersion,
      confirmed: true,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.fieldErrors?.reason ?? res.fieldErrors?.confirmed ?? res.error);
      router.refresh();
      return;
    }
    setDone(true);
    router.refresh();
  }

  if (done)
    return (
      <FormAlert tone="success">
        {suspend
          ? "Account suspended. It's signed out everywhere and the owner is being notified."
          : "Account reactivated. The owner can sign in again and is being notified."}
      </FormAlert>
    );

  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5"
    >
      <h2 className="text-sm font-semibold">{suspend ? "Suspend this account" : "Reactivate this account"}</h2>
      <div
        role="note"
        className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900"
      >
        <Icon name="alert-circle" className="mt-px size-[18px] shrink-0" />
        {suspend ? (
          <p>
            The account is signed out on every device and can&apos;t sign in, its password reset links stop working, and
            any admin role it holds is revoked. Orders, bookings, payouts and the ledger are not changed.
          </p>
        ) : (
          <p>
            The owner can sign in again. Reactivating does <strong>not</strong> restore an admin role, signed-out
            sessions, credentials or payments.
          </p>
        )}
      </div>
      {error && <FormAlert tone="error">{error}</FormAlert>}
      <TextAreaField
        name="reason"
        label="Internal reason"
        hint="Recorded in the audit trail. Never shown to the account owner."
        maxLength={ADMIN_TEXT_LIMITS.reason.max + 50}
        value={reason}
        error={submitted ? reasonError : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      <label className="flex items-start gap-3 text-sm leading-relaxed">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          aria-invalid={submitted && !confirmed ? true : undefined}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span>
          {suspend
            ? "I confirm this account should be suspended and signed out now."
            : "I confirm this account should be able to sign in again."}
        </span>
      </label>
      {submitted && !confirmed && (
        <p role="alert" className="text-xs font-medium text-red-600">
          Tick the box to confirm.
        </p>
      )}
      <Button type="submit" variant={suspend ? "solid" : "outline"} loading={busy}>
        {busy ? "Saving…" : suspend ? "Suspend account" : "Reactivate account"}
      </Button>
    </form>
  );
}
