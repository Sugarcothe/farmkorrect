"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { moderateReview } from "@/lib/admin/api";
import {
  ADMIN_TEXT_LIMITS,
  MODERATION_ACTIONS,
  MODERATION_TRANSITIONS,
  type ModerationAction,
  type ModerationStatus,
} from "@/lib/admin/types";
import { validateAdminReason } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";

const LABELS: Record<ModerationAction, { button: string; busy: string; done: string }> = {
  publish: { button: "Publish", busy: "Publishing…", done: "Review published and the product's rating updated." },
  reject: { button: "Reject", busy: "Rejecting…", done: "Review rejected. It stays hidden from the product." },
  remove: { button: "Remove", busy: "Removing…", done: "Review removed from the product and its rating updated." },
  restore: { button: "Restore", busy: "Restoring…", done: "Review restored to the product and its rating updated." },
};

/**
 * The moderation moves open to one review in its current status. Sends the
 * version it was shown (updatedAt), so a review that changed meanwhile is
 * refused instead of overwritten. Reasons stay internal.
 */
export function ReviewModeration({
  reviewId,
  status,
  updatedAt,
}: {
  reviewId: string;
  status: ModerationStatus;
  updatedAt: string;
}) {
  const router = useRouter();
  const actions = MODERATION_ACTIONS.filter((a) => MODERATION_TRANSITIONS[a].from === status);
  const [chosen, setChosen] = useState<ModerationAction | null>(null);
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const needsReason = chosen ? MODERATION_TRANSITIONS[chosen].reason : false;
  const reasonError = needsReason || cleanText(reason, true) ? validateAdminReason(reason) : undefined;

  async function send(action: ModerationAction) {
    setSubmitted(true);
    if (reasonError) return;
    const text = cleanText(reason, true);
    setBusy(true);
    setError(null);
    const res = await moderateReview(reviewId, { action, updatedAt, ...(text ? { reason: text } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.fieldErrors?.reason ?? res.error);
      router.refresh();
      return;
    }
    setDone(LABELS[action].done);
    router.refresh();
  }

  if (done) return <FormAlert tone="success">{done}</FormAlert>;
  if (!actions.length) return null;

  if (!chosen)
    return (
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            type="button"
            variant={action === "publish" || action === "restore" ? "solid" : "outline"}
            className="h-10 w-auto flex-1 text-sm"
            onClick={() => (MODERATION_TRANSITIONS[action].reason ? setChosen(action) : send(action))}
            loading={busy}
            disabled={busy}
          >
            {LABELS[action].button}
          </Button>
        ))}
        {error && (
          <div className="w-full">
            <FormAlert tone="error">{error}</FormAlert>
          </div>
        )}
      </div>
    );

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send(chosen);
      }}
      className="space-y-3"
    >
      {error && <FormAlert tone="error">{error}</FormAlert>}
      <TextAreaField
        name="reason"
        label={`Reason to ${LABELS[chosen].button.toLowerCase()}`}
        hint="Internal: kept in the audit trail, not shown to the reviewer or seller."
        maxLength={ADMIN_TEXT_LIMITS.reason.max + 50}
        value={reason}
        error={submitted ? reasonError : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="outline"
          className="h-10 text-sm"
          disabled={busy}
          onClick={() => {
            setChosen(null);
            setSubmitted(false);
          }}
        >
          Back
        </Button>
        <Button type="submit" className="h-10 text-sm" loading={busy}>
          {busy ? LABELS[chosen].busy : LABELS[chosen].button}
        </Button>
      </div>
    </form>
  );
}
