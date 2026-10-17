"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { closeIssue } from "@/lib/admin/api";
import { ADMIN_TEXT_LIMITS } from "@/lib/admin/types";
import { validateResolutionNote } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";

/**
 * Closes a reported order issue with an internal resolution note. Closing
 * releases the seller's held earning through the ledger and never refunds
 * the buyer, so the admin has to confirm that explicitly. Success is only
 * shown once the server has closed it.
 */
export function CloseIssueForm({ orderNumber }: { orderNumber: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const noteError = validateResolutionNote(note);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (noteError || !confirmed) return;
    setBusy(true);
    setError(null);
    const res = await closeIssue(orderNumber, { note: cleanText(note, true), confirmed: true });
    setBusy(false);
    if (!res.ok) {
      setError(res.fieldErrors?.note ?? res.fieldErrors?.confirmed ?? res.error);
      router.refresh();
      return;
    }
    setDone(true);
    router.refresh();
  }

  if (done)
    return (
      <FormAlert tone="success">
        Issue closed. The seller&apos;s earning is released from review in the ledger, and both sides are told in the
        app.
      </FormAlert>
    );

  return (
    <form onSubmit={submit} noValidate className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
      <h2 className="text-sm font-semibold">Close this issue</h2>
      <div role="note" className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
        <Icon name="alert-circle" className="mt-px size-[18px] shrink-0" />
        <p>
          Closing releases the seller&apos;s held earning for this order. It does <strong>not</strong> refund the buyer.
          If a refund is due, make sure the seller has issued it before closing.
        </p>
      </div>
      {error && <FormAlert tone="error">{error}</FormAlert>}
      <TextAreaField
        name="note"
        label="Internal resolution note"
        hint="What was found and how it was resolved. Can't be changed later; not shown to the buyer or seller."
        maxLength={ADMIN_TEXT_LIMITS.resolutionNote.max + 50}
        value={note}
        error={submitted ? noteError : undefined}
        onChange={(e) => setNote(e.target.value)}
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
          I confirm the case is resolved, any refund due was already handled, and the seller&apos;s earning can be
          released.
        </span>
      </label>
      {submitted && !confirmed && (
        <p role="alert" className="text-xs font-medium text-red-600">
          Tick the box to confirm before closing.
        </p>
      )}
      <Button type="submit" loading={busy}>
        {busy ? "Closing…" : "Close issue"}
      </Button>
    </form>
  );
}
