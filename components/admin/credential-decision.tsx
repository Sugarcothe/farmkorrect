"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { decideCredential } from "@/lib/admin/api";
import { ADMIN_TEXT_LIMITS, type CredentialDecision } from "@/lib/admin/types";
import { validateAdminReason } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";

/**
 * Approve or reject one pending credential submission. Sends the submission
 * time it was shown, so a changed or already-decided submission is refused
 * by the server. The outcome shown is the server's, read back after saving.
 */
export function CredentialDecisionForm({ userId, submittedAt }: { userId: string; submittedAt: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<CredentialDecision | null>(null);
  const [reason, setReason] = useState("");
  // the last button pressed: a reason is required to reject, optional (but checked) to approve
  const [attempt, setAttempt] = useState<CredentialDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reasonError = (decision: CredentialDecision | null) =>
    decision === "reject" || (decision === "approve" && cleanText(reason, true)) ? validateAdminReason(reason) : undefined;

  async function decide(decision: CredentialDecision) {
    setAttempt(decision);
    if (reasonError(decision)) return;
    const text = cleanText(reason, true);
    setBusy(decision);
    setError(null);
    const res = await decideCredential(userId, { decision, submittedAt, ...(text ? { reason: text } : {}) });
    setBusy(null);
    if (!res.ok) {
      setError(res.fieldErrors?.reason ?? res.error);
      router.refresh();
      return;
    }
    setDone(
      res.data.case.status === "verified"
        ? "Credential approved. The professional has been told in the app."
        : "Credential rejected. The professional has been told in the app; your reason stays internal.",
    );
    router.refresh();
  }

  if (done) return <FormAlert tone="success">{done}</FormAlert>;

  return (
    <form
      noValidate
      onSubmit={(e) => e.preventDefault()}
      className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5"
    >
      <h2 className="text-sm font-semibold">Your decision</h2>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Approving marks the profile as checked by the Farm Korret team, based on the details shown here. It isn&apos;t a
        check against an official licensing register.
      </p>
      {error && <FormAlert tone="error">{error}</FormAlert>}
      <TextAreaField
        name="reason"
        label="Reason (required to reject)"
        hint="Internal: kept in the audit trail, not shown to the professional."
        maxLength={ADMIN_TEXT_LIMITS.reason.max + 50}
        value={reason}
        error={reasonError(attempt)}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="outline"
          className="border-red-600 text-red-700 hover:bg-red-50"
          loading={busy === "reject"}
          disabled={busy !== null}
          onClick={() => decide("reject")}
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </Button>
        <Button type="button" loading={busy === "approve"} disabled={busy !== null} onClick={() => decide("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </Button>
      </div>
    </form>
  );
}
