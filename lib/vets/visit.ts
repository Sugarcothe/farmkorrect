// The vet's visit record for an appointment that has started: a checklist
// and private clinical notes. Shared by the browser and the server; the
// server decides and stores everything (see lib/server/visits.ts and
// docs/vet-job-workflow.md).
//
// This is documentation of the visit, not clinical guidance: ticking an item
// records that the vet says they did it. Nothing here suggests a treatment,
// a dose or a diagnosis.

/** Bump when the item ids, wording or required flags change. Visits keep the version they started with. */
export const VISIT_TEMPLATE_VERSION = 1;

export type ChecklistTemplateItem = { id: string; label: string; required: boolean };

/** What the agreed service step says, per veterinary service category. */
const SERVICE_STEP: Record<string, string> = {
  consultation: "Consultation held with the farmer",
  vaccination: "Vaccine administered as agreed",
  "biosecurity-audit": "Biosecurity audit of the premises carried out",
  "disease-advisory": "Flock examined for the reported problem",
  "flock-health-check": "Routine flock health check carried out",
  "post-mortem": "Post-mortem done or samples sent for lab referral",
  "emergency-visit": "Emergency attended to",
};

/** The checklist a visit starts with, for its service category. Ids never change meaning. */
export function checklistTemplate(category: string): ChecklistTemplateItem[] {
  return [
    { id: "arrived", label: "Arrived at the farm", required: true },
    { id: "assessment", label: "Pre-service assessment of the flock", required: true },
    { id: "service", label: SERVICE_STEP[category] ?? "Agreed service carried out", required: true },
    { id: "records", label: "Visit records completed for the farmer", required: true },
    { id: "follow-up", label: "Follow-up discussed with the farmer", required: false },
  ];
}

/** Vaccination visits also record the product, batch and how it was given. */
export const hasVaccineDetails = (category: string) => category === "vaccination";

export const VISIT_NOTE_FIELDS = [
  { key: "observations", label: "Clinical observations", max: 2000, rows: 4 },
  { key: "findings", label: "Relevant findings", max: 2000, rows: 3 },
  { key: "procedure", label: "Service or procedure details", max: 2000, rows: 3 },
  { key: "followUp", label: "Follow-up recommendations", max: 1000, rows: 3 },
] as const;

export const VACCINE_FIELDS = [
  { key: "vaccineProduct", label: "Vaccine product", max: 120 },
  { key: "vaccineBatch", label: "Batch / lot number", max: 60 },
  { key: "vaccineAdministration", label: "Administration details (route, birds, time)", max: 300 },
] as const;

export type VisitNoteKey = (typeof VISIT_NOTE_FIELDS)[number]["key"] | (typeof VACCINE_FIELDS)[number]["key"];
export type VisitNotes = Record<VisitNoteKey, string>;

export const EMPTY_NOTES: VisitNotes = {
  observations: "",
  findings: "",
  procedure: "",
  followUp: "",
  vaccineProduct: "",
  vaccineBatch: "",
  vaccineAdministration: "",
};

export type VisitChecklistItem = ChecklistTemplateItem & {
  /** when the vet ticked it; null while not done */
  doneAt: string | null;
};

/** The visit record as the assigned vet sees it. Never sent to the customer. */
export type VisitRecord = {
  template: { category: string; version: number };
  checklist: VisitChecklistItem[];
  vaccineDetails: boolean;
  notes: VisitNotes;
  /** pass back as `expectedVersion` when saving notes; a newer version is a 409 */
  notesVersion: number;
  notesUpdatedAt: string | null;
  /** false: an appointment that started before visit records existed, shown from the current template */
  stored: boolean;
  /** notes and checklist can be changed (the visit is in progress) */
  editable: boolean;
};

export type VisitResponse = { visit: VisitRecord };
export type ChecklistUpdateRequest = { itemId: string; done: boolean };
export type NotesUpdateRequest = { notes: Partial<VisitNotes>; expectedVersion: number };

/** What still stands between this visit and "completed". Empty when it can be completed. */
export function missingForCompletion(visit: Pick<VisitRecord, "checklist" | "notes">): string[] {
  const missing = visit.checklist.filter((i) => i.required && !i.doneAt).map((i) => i.label);
  if (!visit.notes.observations.trim()) missing.push("Clinical observations saved in the notes");
  return missing;
}
