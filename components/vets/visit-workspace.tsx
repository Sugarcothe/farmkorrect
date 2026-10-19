"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { changeAppointment, saveVisitNotes, updateChecklist } from "@/lib/vets/api";
import { formatSlot } from "@/lib/vets/schedule";
import type { Appointment } from "@/lib/vets/types";
import {
  EMPTY_NOTES,
  missingForCompletion,
  VACCINE_FIELDS,
  VISIT_NOTE_FIELDS,
  type VisitNoteKey,
  type VisitNotes,
  type VisitRecord,
} from "@/lib/vets/visit";
import { Section } from "./vet-parts";

const sameNotes = (a: VisitNotes, b: VisitNotes) =>
  (Object.keys(EMPTY_NOTES) as VisitNoteKey[]).every((k) => a[k] === b[k]);

/**
 * The vet's working view of a visit: the checklist, private clinical notes
 * and "Complete visit". Everything is saved and checked by the server; this
 * only shows what it last confirmed. Once completed it's read-only.
 *
 * The checklist records what the vet says was done. It isn't clinical
 * guidance and doesn't judge whether an intervention was right.
 */
export function VisitWorkspace({ appointment, visit: initial }: { appointment: Appointment; visit: VisitRecord }) {
  const router = useRouter();
  const [visit, setVisit] = useState(initial);
  const [draft, setDraft] = useState<VisitNotes>({ ...EMPTY_NOTES, ...initial.notes });
  const [savingItem, setSavingItem] = useState<string | null>(null);
  const [checklistError, setChecklistError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [saving, setSaving] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string[] | null>(null);
  const inFlight = useRef(false);

  const editable = visit.editable;
  const dirty = !sameNotes(draft, visit.notes);
  const missing = missingForCompletion(visit);
  const canComplete = editable && appointment.actions.includes("complete");
  const noteFields = [...VISIT_NOTE_FIELDS, ...(visit.vaccineDetails ? VACCINE_FIELDS : [])];

  async function toggle(itemId: string, label: string, done: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSavingItem(itemId);
    setChecklistError(null);
    const res = await updateChecklist(appointment.id, { itemId, done });
    inFlight.current = false;
    setSavingItem(null);
    if (res.ok) {
      setVisit((v) => ({
        ...res.data.visit,
        notes: v.notes,
        notesVersion: v.notesVersion,
        notesUpdatedAt: v.notesUpdatedAt,
      }));
      setAnnounce(`${label}: ${done ? "marked done" : "marked not done"}.`);
    } else {
      setChecklistError(res.error);
      router.refresh();
    }
  }

  async function save() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setNotesError(null);
    setFieldErrors({});
    const changed = Object.fromEntries(
      (Object.keys(EMPTY_NOTES) as VisitNoteKey[]).filter((k) => draft[k] !== visit.notes[k]).map((k) => [k, draft[k]]),
    );
    const res = await saveVisitNotes(appointment.id, { notes: changed, expectedVersion: visit.notesVersion });
    inFlight.current = false;
    setSaving(false);
    if (res.ok) {
      const saved = res.data.visit;
      setVisit((v) => ({ ...saved, checklist: v.checklist }));
      setDraft({ ...EMPTY_NOTES, ...saved.notes });
      setAnnounce("Notes saved.");
      return;
    }
    if (res.fieldErrors?.expectedVersion) setConflict(true);
    else if (res.fieldErrors) setFieldErrors(res.fieldErrors);
    setNotesError(res.error);
  }

  async function complete() {
    if (inFlight.current) return;
    inFlight.current = true;
    setCompleting(true);
    setCompleteError(null);
    const res = await changeAppointment(appointment.id, { action: "complete", expectedStatus: "in_progress" });
    inFlight.current = false;
    setCompleting(false);
    setConfirming(false);
    if (!res.ok) setCompleteError([res.error, ...(res.fieldErrors?.missing ? [res.fieldErrors.missing] : [])]);
    router.refresh();
  }

  const doneCount = visit.checklist.filter((i) => i.doneAt).length;

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      <Section title="Visit checklist">
        <p className="-mt-1 mb-3 text-xs text-muted-foreground">
          {doneCount} of {visit.checklist.length} done. Items marked required must be ticked before the visit can be
          completed. This is a record of the visit, not clinical guidance.
        </p>
        {checklistError && (
          <div className="mb-3">
            <FormAlert>{checklistError}</FormAlert>
          </div>
        )}
        <ul className="space-y-1">
          {visit.checklist.map((item) => {
            const id = `check-${item.id}`;
            return (
              <li key={item.id}>
                <label
                  htmlFor={id}
                  className={`flex items-start gap-3 rounded-2xl px-2 py-2.5 ${editable ? "cursor-pointer hover:bg-foreground/[0.03]" : ""}`}
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={item.doneAt !== null}
                    disabled={!editable || savingItem !== null}
                    aria-describedby={`${id}-meta`}
                    onChange={(e) => void toggle(item.id, item.label, e.target.checked)}
                    className="mt-0.5 size-5 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{item.label}</span>
                    <span id={`${id}-meta`} className="block text-xs text-muted-foreground">
                      {item.required ? "Required" : "Optional"}
                      {item.doneAt ? ` · done ${formatSlot(item.doneAt, false)}` : ""}
                      {savingItem === item.id ? " · saving…" : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Clinical notes">
        <p className="-mt-1 mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Icon name="lock" className="mt-px size-3.5 shrink-0" />
          Private to you. The customer doesn&rsquo;t see these notes.
        </p>
        {editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-3"
            noValidate
          >
            {noteFields.map((f) =>
              "rows" in f ? (
                <TextAreaField
                  key={f.key}
                  name={f.key}
                  label={f.key === "observations" ? `${f.label} (required to complete)` : f.label}
                  rows={f.rows}
                  maxLength={f.max}
                  value={draft[f.key]}
                  error={fieldErrors[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              ) : (
                <TextField
                  key={f.key}
                  name={f.key}
                  label={f.label}
                  maxLength={f.max}
                  value={draft[f.key]}
                  error={fieldErrors[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              ),
            )}
            {notesError && <FormAlert>{notesError}</FormAlert>}
            {conflict && (
              <Button type="button" variant="outline" onClick={() => router.refresh()}>
                Reload the latest notes
              </Button>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {dirty
                  ? "Unsaved changes"
                  : visit.notesUpdatedAt
                    ? `Saved ${formatSlot(visit.notesUpdatedAt)}`
                    : "Nothing saved yet"}
              </p>
              <Button type="submit" className="w-auto px-6" loading={saving} disabled={!dirty || conflict}>
                Save notes
              </Button>
            </div>
          </form>
        ) : (
          <dl className="space-y-3 text-sm">
            {noteFields.map((f) => (
              <div key={f.key}>
                <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
                <dd className="mt-0.5 whitespace-pre-line">{visit.notes[f.key] || "—"}</dd>
              </div>
            ))}
            {visit.notesUpdatedAt && (
              <p className="text-xs text-muted-foreground">Last saved {formatSlot(visit.notesUpdatedAt)}</p>
            )}
          </dl>
        )}
      </Section>

      {canComplete && (
        <Section title="Complete visit">
          {missing.length > 0 ? (
            <div className="mb-3 text-sm">
              <p className="font-medium">Still needed before you can complete:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground/75">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mb-3 text-sm text-foreground/75">
              Everything required is recorded. Completing makes this visit record read-only.
            </p>
          )}
          {dirty && (
            <p className="mb-3 text-xs text-amber-700">Save your notes first: unsaved changes aren&rsquo;t included.</p>
          )}
          {completeError && (
            <div className="mb-3">
              <FormAlert>{completeError.join(" ")}</FormAlert>
            </div>
          )}
          {confirming ? (
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant="outline" disabled={completing} onClick={() => setConfirming(false)}>
                Not yet
              </Button>
              <Button type="button" loading={completing} onClick={() => void complete()}>
                Yes, complete
              </Button>
            </div>
          ) : (
            <Button type="button" disabled={missing.length > 0 || dirty} onClick={() => setConfirming(true)}>
              Complete visit
            </Button>
          )}
        </Section>
      )}
    </>
  );
}
