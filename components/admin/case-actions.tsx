"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { changeCase } from "@/lib/admin/api";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUS_LABELS,
  CASE_TEXT_LIMITS,
  isClosedStatus,
  RESOLUTION_CODES,
  RESOLUTION_LABELS,
  WORKING_STATUSES,
  type Assignee,
  type CaseChangeRequest,
  type CaseDetail,
  type CasePermissions,
  type ResolutionCode,
} from "@/lib/admin/cases";
import { ADMIN_ROLE_LABELS } from "@/lib/admin/permissions";
import { validateLimitedText } from "@/lib/admin/validation";
import { cleanText } from "@/lib/profile/validation";

type Distributive<T> = T extends unknown ? Omit<T, "expectedVersion"> : never;
type Change = Distributive<CaseChangeRequest>;

const selectClass =
  "h-11 w-full min-w-0 rounded-full border border-foreground/10 bg-white px-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent";
const card = "space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5";

/**
 * Everything an admin can do with one case. What's offered comes from the
 * server's permissions for this viewer, and every change carries the
 * version the page was loaded at: if someone else changed the case first,
 * the server refuses (409) and the page reloads. Success is only shown
 * once the server has made the change.
 */
export function CaseActions({
  detail,
  permissions,
  assignees,
  viewerId,
  canManage,
}: {
  detail: CaseDetail;
  permissions: CasePermissions;
  assignees: Assignee[];
  viewerId: string;
  /** may take an unassigned case or release their own */
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState<"resolve" | "dismiss" | null>(null);
  const [code, setCode] = useState<ResolutionCode | "">("");
  const [closeNote, setCloseNote] = useState("");
  const [reason, setReason] = useState("");
  const closed = isClosedStatus(detail.status);
  const mine = detail.assignee?.id === viewerId;

  async function send(key: string, change: Change, success: string) {
    setBusy(key);
    setError(null);
    setFieldErrors({});
    setDone(null);
    const res = await changeCase(detail.reference, { ...change, expectedVersion: detail.version } as CaseChangeRequest);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      setFieldErrors(res.fieldErrors ?? {});
      router.refresh();
      return false;
    }
    setDone(success);
    router.refresh();
    return true;
  }

  const noteError = validateLimitedText(cleanText(note, true), CASE_TEXT_LIMITS.note, "Write a note.");
  const closeNoteError = validateLimitedText(
    cleanText(closeNote, true),
    CASE_TEXT_LIMITS.resolutionNote,
    "Write an internal note on the outcome.",
  );
  const reasonError = validateLimitedText(
    cleanText(reason, true),
    CASE_TEXT_LIMITS.reopenReason,
    "Say why the case is being reopened.",
  );

  return (
    <div className="space-y-4">
      {error && <FormAlert tone="error">{error}</FormAlert>}
      {done && <FormAlert tone="success">{done}</FormAlert>}

      {closed ? (
        permissions.work && (
          <form
            className={card}
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              if (reasonError) return setFieldErrors({ reason: reasonError });
              if (await send("reopen", { action: "reopen", reason: cleanText(reason, true) }, "Case reopened."))
                setReason("");
            }}
          >
            <h2 className="text-sm font-semibold">Reopen this case</h2>
            <TextAreaField
              name="reason"
              label="Why it's being reopened"
              hint="Recorded in the audit trail."
              maxLength={CASE_TEXT_LIMITS.reopenReason.max + 50}
              value={reason}
              error={fieldErrors.reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button type="submit" variant="outline" loading={busy === "reopen"}>
              Reopen case
            </Button>
          </form>
        )
      ) : (
        <>
          {(permissions.assign || (canManage && (!detail.assignee || mine))) && (
            <section className={card} aria-labelledby="assign-heading">
              <h2 id="assign-heading" className="text-sm font-semibold">
                Assignment
              </h2>
              {permissions.assign ? (
                <select
                  aria-label="Assign to"
                  className={selectClass}
                  value={detail.assignee?.id ?? ""}
                  disabled={busy !== null}
                  onChange={(e) =>
                    send("assign", { action: "assign", assigneeId: e.target.value || null }, "Assignment updated.")
                  }
                >
                  <option value="">Unassigned</option>
                  {detail.assignee && !assignees.some((a) => a.id === detail.assignee!.id) && (
                    <option value={detail.assignee.id}>{detail.assignee.name}</option>
                  )}
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {ADMIN_ROLE_LABELS[a.role]}
                    </option>
                  ))}
                </select>
              ) : mine ? (
                <Button
                  variant="outline"
                  loading={busy === "assign"}
                  onClick={() => send("assign", { action: "assign", assigneeId: null }, "You released the case.")}
                >
                  Release this case
                </Button>
              ) : (
                <Button
                  variant="outline"
                  loading={busy === "assign"}
                  onClick={() => send("assign", { action: "assign", assigneeId: viewerId }, "The case is yours.")}
                >
                  Take this case
                </Button>
              )}
            </section>
          )}

          {permissions.work && (
            <section className={`${card} grid grid-cols-2 gap-3 space-y-0`} aria-label="Status and priority">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Status
                <select
                  className={selectClass}
                  value={detail.status}
                  disabled={busy !== null}
                  onChange={(e) =>
                    send("status", { action: "status", status: e.target.value as never }, "Status updated.")
                  }
                >
                  {WORKING_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {CASE_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Priority
                <select
                  className={selectClass}
                  value={detail.priority}
                  disabled={busy !== null}
                  onChange={(e) =>
                    send("priority", { action: "priority", priority: e.target.value as never }, "Priority updated.")
                  }
                >
                  {CASE_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {CASE_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}

          {permissions.note && (
            <form
              className={card}
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                if (noteError) return setFieldErrors({ note: noteError });
                if (await send("note", { action: "note", note: cleanText(note, true) }, "Note added.")) setNote("");
              }}
            >
              <h2 className="text-sm font-semibold">Add a note</h2>
              <TextAreaField
                name="note"
                label="Internal note"
                hint="Notes can't be edited or removed, and are never shown to customers or providers."
                maxLength={CASE_TEXT_LIMITS.note.max + 50}
                value={note}
                error={fieldErrors.note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button type="submit" variant="outline" loading={busy === "note"}>
                Add note
              </Button>
            </form>
          )}

          {permissions.work && (
            <section className={card} aria-labelledby="close-heading">
              <h2 id="close-heading" className="text-sm font-semibold">
                Close this case
              </h2>
              {closing === null ? (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => setClosing("resolve")}>
                    Resolve
                  </Button>
                  <Button variant="ghost" onClick={() => setClosing("dismiss")}>
                    Dismiss
                  </Button>
                </div>
              ) : (
                <form
                  className="space-y-3"
                  noValidate
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const errors: Record<string, string> = {};
                    if (!code) errors.code = "Choose an outcome.";
                    if (closeNoteError) errors.note = closeNoteError;
                    if (Object.keys(errors).length) return setFieldErrors(errors);
                    const ok = await send(
                      closing,
                      { action: closing, code: code as ResolutionCode, note: cleanText(closeNote, true) },
                      closing === "resolve" ? "Case resolved." : "Case dismissed.",
                    );
                    if (ok) {
                      setClosing(null);
                      setCode("");
                      setCloseNote("");
                    }
                  }}
                >
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {closing === "resolve" ? "Resolving" : "Dismissing"} closes the case only. It doesn&apos;t refund,
                    pay out, retry or change the record it&apos;s about.
                  </p>
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Outcome
                    <select
                      className={selectClass}
                      value={code}
                      aria-invalid={fieldErrors.code ? true : undefined}
                      onChange={(e) => setCode(e.target.value as ResolutionCode)}
                    >
                      <option value="" disabled>
                        Choose an outcome
                      </option>
                      {RESOLUTION_CODES.map((c) => (
                        <option key={c} value={c}>
                          {RESOLUTION_LABELS[c]}
                        </option>
                      ))}
                    </select>
                    {fieldErrors.code && (
                      <span role="alert" className="text-xs text-red-600">
                        {fieldErrors.code}
                      </span>
                    )}
                  </label>
                  <TextAreaField
                    name="closeNote"
                    label="Internal note on the outcome"
                    hint="What was found and done. Recorded in the audit trail; not shown to customers or providers."
                    maxLength={CASE_TEXT_LIMITS.resolutionNote.max + 50}
                    value={closeNote}
                    error={fieldErrors.note}
                    onChange={(e) => setCloseNote(e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="submit" loading={busy === closing}>
                      {closing === "resolve" ? "Resolve case" : "Dismiss case"}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setClosing(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
