import "server-only";
import type { Filter, ObjectId } from "mongodb";
import { cleanText } from "@/lib/profile/validation";
import {
  checklistTemplate,
  EMPTY_NOTES,
  hasVaccineDetails,
  VACCINE_FIELDS,
  VISIT_NOTE_FIELDS,
  VISIT_TEMPLATE_VERSION,
  type VisitNoteKey,
  type VisitNotes,
  type VisitRecord,
} from "@/lib/vets/visit";
import { getDb } from "./db";
import { HttpError } from "./http";
import { COLLECTIONS, type AppointmentDoc, type AppointmentVisitDoc, type UserDoc } from "./models";
import { parseId } from "./vet-directory";

// The vet's visit record on an appointment: a checklist snapshot and private
// clinical notes (docs/vet-job-workflow.md).
//
// - Only the appointment's own vet can read or change it; anyone else gets
//   the same 404 as for an unknown id. The customer's view of the
//   appointment never includes it.
// - It can only change while the visit is in progress, through conditional
//   updates on that status, so nothing changes after completion.
// - Checklist updates set an item to a state, so a repeat changes nothing.
//   Notes carry a version; a save based on an older version is a 409 rather
//   than silently overwriting newer notes.
// - Note text is never logged, put in a URL or sent in a notification.

export const VISIT_NOT_FOUND = "We couldn't find that appointment.";
export const VISIT_NOT_IN_PROGRESS = "The visit record can only be changed while the visit is in progress.";
export const NOTES_CONFLICT =
  "These notes were changed somewhere else since you opened them. Reload to see the latest version before saving.";

async function appointments() {
  return (await getDb()).collection<AppointmentDoc>(COLLECTIONS.appointments);
}

/** A fresh visit record from the current template for the service category. */
export function newVisit(category: string, now: Date): AppointmentVisitDoc {
  return {
    template: { category, version: VISIT_TEMPLATE_VERSION },
    checklist: checklistTemplate(category).map((item) => ({ ...item, doneAt: null, doneBy: null })),
    vaccineDetails: hasVaccineDetails(category),
    notes: { ...EMPTY_NOTES },
    notesVersion: 0,
    notesUpdatedAt: null,
    notesUpdatedBy: null,
    createdAt: now,
  };
}

/**
 * When the visit started: the stored timestamp, or for older appointments
 * the last recorded move to in_progress. Null if it never started or the
 * time can't be established.
 */
export function visitStartedAt(doc: Pick<AppointmentDoc, "startedAt" | "history">): Date | null {
  if (doc.startedAt) return doc.startedAt;
  for (let i = doc.history.length - 1; i >= 0; i--)
    if (doc.history[i].status === "in_progress") return doc.history[i].at;
  return null;
}

export function visitCompletedAt(doc: Pick<AppointmentDoc, "completedAt" | "history" | "bookingStatus">): Date | null {
  if (doc.completedAt) return doc.completedAt;
  if (doc.bookingStatus !== "completed") return null;
  return doc.history.findLast((h) => h.status === "completed")?.at ?? null;
}

/** The assigned vet's view of the visit record; null before the visit starts or once it ended without one. */
export function toVisitRecord(doc: AppointmentDoc): VisitRecord | null {
  const editable = doc.bookingStatus === "in_progress";
  if (!editable && doc.bookingStatus !== "completed") return null;
  const visit = doc.visit;
  if (!visit) {
    // started before visit records existed: completed ones have none; in-progress ones get one on the first change
    if (!editable) return null;
    const fresh = newVisit(doc.service.category, doc.updatedAt);
    return { ...serialize(fresh), stored: false, editable };
  }
  return { ...serialize(visit), stored: true, editable };
}

function serialize(visit: AppointmentVisitDoc): Omit<VisitRecord, "stored" | "editable"> {
  return {
    template: visit.template,
    checklist: visit.checklist.map((i) => ({
      id: i.id,
      label: i.label,
      required: i.required,
      doneAt: i.doneAt?.toISOString() ?? null,
    })),
    vaccineDetails: visit.vaccineDetails,
    notes: { ...EMPTY_NOTES, ...visit.notes },
    notesVersion: visit.notesVersion,
    notesUpdatedAt: visit.notesUpdatedAt?.toISOString() ?? null,
  };
}

/**
 * Only an appointment whose visit record is complete can move to
 * completed: every required item ticked and observations saved. Part of the
 * completion update's filter, so it's checked atomically.
 */
export const COMPLETABLE: Filter<AppointmentDoc> = {
  "visit.checklist": { $not: { $elemMatch: { required: true, doneAt: null } } },
  "visit.notes.observations": { $nin: ["", null] },
};

/** The appointment if this user is its vet; a 404 otherwise (customers, other vets, bad ids). */
export async function findVetAppointment(user: Pick<UserDoc, "_id">, id: unknown): Promise<AppointmentDoc> {
  const _id = parseId(id);
  const doc = _id ? await (await appointments()).findOne({ _id, vetUserId: user._id }) : null;
  if (!doc) throw new HttpError(404, VISIT_NOT_FOUND);
  return doc;
}

/** Gives an in-progress appointment that started before visit records existed its record. */
export async function ensureVisit(doc: AppointmentDoc, now = new Date()): Promise<AppointmentDoc> {
  if (doc.visit || doc.bookingStatus !== "in_progress") return doc;
  const collection = await appointments();
  await collection.updateOne(
    { _id: doc._id, bookingStatus: "in_progress", visit: null },
    { $set: { visit: newVisit(doc.service.category, now) } },
  );
  return (await collection.findOne({ _id: doc._id })) ?? doc;
}

// --- the checklist -----------------------------------------------------------------

export type ParsedChecklistUpdate = { itemId: string; done: boolean };

export function parseChecklistUpdate(body: Record<string, unknown>): ParsedChecklistUpdate {
  const fieldErrors: Record<string, string> = {};
  if (typeof body.itemId !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(body.itemId))
    fieldErrors.itemId = "Choose a checklist item.";
  if (typeof body.done !== "boolean") fieldErrors.done = "Say whether the item is done.";
  if (Object.keys(fieldErrors).length > 0)
    throw new HttpError(400, "That checklist change couldn't be made.", fieldErrors);
  return { itemId: body.itemId as string, done: body.done as boolean };
}

/**
 * Ticks or clears one item for the session's vet. Setting an item to the
 * state it's already in changes nothing and returns the record as it is.
 */
export async function updateChecklist(
  user: Pick<UserDoc, "_id">,
  id: unknown,
  input: ParsedChecklistUpdate,
  now = new Date(),
): Promise<AppointmentDoc> {
  const doc = await ensureVisit(await findVetAppointment(user, id), now);
  if (doc.bookingStatus !== "in_progress" || !doc.visit) throw new HttpError(409, VISIT_NOT_IN_PROGRESS);
  // the visit's own snapshot decides which items exist, not the current template
  if (!doc.visit.checklist.some((i) => i.id === input.itemId))
    throw new HttpError(400, "That checklist change couldn't be made.", {
      itemId: "That item isn't on this visit's checklist.",
    });

  const collection = await appointments();
  const updated = await collection.findOneAndUpdate(
    {
      _id: doc._id,
      vetUserId: user._id,
      bookingStatus: "in_progress",
      "visit.checklist": { $elemMatch: { id: input.itemId, doneAt: input.done ? null : { $ne: null } } },
    },
    {
      $set: {
        "visit.checklist.$[item].doneAt": input.done ? now : null,
        "visit.checklist.$[item].doneBy": input.done ? (user._id as ObjectId) : null,
        updatedAt: now,
      },
    },
    { arrayFilters: [{ "item.id": input.itemId }], returnDocument: "after" },
  );
  if (updated) return updated;
  // nothing matched: already in that state (a repeat), or the visit moved on meanwhile
  const current = await collection.findOne({ _id: doc._id, vetUserId: user._id });
  if (!current) throw new HttpError(404, VISIT_NOT_FOUND);
  if (current.bookingStatus !== "in_progress") throw new HttpError(409, VISIT_NOT_IN_PROGRESS);
  return current;
}

// --- clinical notes ------------------------------------------------------------------

export type ParsedNotesUpdate = { notes: Partial<VisitNotes>; expectedVersion: number };

const NOTE_LIMITS = new Map<string, { max: number; multiline: boolean }>([
  ...VISIT_NOTE_FIELDS.map((f) => [f.key, { max: f.max, multiline: true }] as const),
  ...VACCINE_FIELDS.map((f) => [f.key, { max: f.max, multiline: f.key === "vaccineAdministration" }] as const),
]);

/** Larger than the default JSON limit: every note field at its longest, in multi-byte text. */
export const NOTES_MAX_BYTES = 48 * 1024;

export function parseNotesUpdate(body: Record<string, unknown>): ParsedNotesUpdate {
  const fieldErrors: Record<string, string> = {};
  const raw = body.notes;
  const notes: Partial<VisitNotes> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fieldErrors.notes = "Enter your notes.";
  else
    for (const [key, value] of Object.entries(raw)) {
      const limit = NOTE_LIMITS.get(key);
      if (!limit) {
        fieldErrors[key] = "This isn't a note field.";
        continue;
      }
      if (typeof value !== "string") {
        fieldErrors[key] = "Enter text.";
        continue;
      }
      const text = cleanText(value, limit.multiline);
      if (text.length > limit.max) fieldErrors[key] = `Keep this to ${limit.max} characters.`;
      notes[key as VisitNoteKey] = text;
    }
  const version = body.expectedVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 1_000_000)
    fieldErrors.expectedVersion = "Reload the page and try again.";
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Please check the notes.", fieldErrors);
  return { notes, expectedVersion: version as number };
}

const sameNotes = (a: VisitNotes, b: VisitNotes) =>
  (Object.keys(EMPTY_NOTES) as VisitNoteKey[]).every((k) => (a[k] ?? "") === (b[k] ?? ""));

/**
 * Saves the vet's notes if they're still at `expectedVersion`. A retry of a
 * save that already landed returns the record; any other newer version is a
 * 409, so a stale screen never overwrites newer notes.
 */
export async function saveVisitNotes(
  user: Pick<UserDoc, "_id">,
  id: unknown,
  input: ParsedNotesUpdate,
  now = new Date(),
): Promise<AppointmentDoc> {
  const doc = await ensureVisit(await findVetAppointment(user, id), now);
  if (doc.bookingStatus !== "in_progress" || !doc.visit) throw new HttpError(409, VISIT_NOT_IN_PROGRESS);
  if (!doc.visit.vaccineDetails) {
    const extra = VACCINE_FIELDS.filter((f) => input.notes[f.key]);
    if (extra.length > 0)
      throw new HttpError(
        400,
        "Please check the notes.",
        Object.fromEntries(extra.map((f) => [f.key, "Vaccine details are only recorded for vaccination visits."])),
      );
  }
  const notes: VisitNotes = { ...EMPTY_NOTES, ...doc.visit.notes, ...input.notes };

  const collection = await appointments();
  const updated = await collection.findOneAndUpdate(
    { _id: doc._id, vetUserId: user._id, bookingStatus: "in_progress", "visit.notesVersion": input.expectedVersion },
    {
      $set: {
        "visit.notes": notes,
        "visit.notesUpdatedAt": now,
        "visit.notesUpdatedBy": user._id as ObjectId,
        updatedAt: now,
      },
      $inc: { "visit.notesVersion": 1 },
    },
    { returnDocument: "after" },
  );
  if (updated) return updated;
  const current = await collection.findOne({ _id: doc._id, vetUserId: user._id });
  if (!current) throw new HttpError(404, VISIT_NOT_FOUND);
  if (current.bookingStatus !== "in_progress" || !current.visit) throw new HttpError(409, VISIT_NOT_IN_PROGRESS);
  if (sameNotes({ ...EMPTY_NOTES, ...current.visit.notes }, notes)) return current;
  throw new HttpError(409, NOTES_CONFLICT, { expectedVersion: "Newer notes were saved. Reload them before saving." });
}
