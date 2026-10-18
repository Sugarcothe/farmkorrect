"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { formatDate } from "@/components/wallet/wallet-parts";
import { changeStaffRole, inviteStaff, removeStaff, saveProgram } from "@/lib/training/api";
import {
  STAFF_ROLES,
  TRAINING_LIMITS,
  type ProgramCourse,
  type StaffMember,
  type StaffOverview,
  type StaffProgram,
  type StaffRole,
} from "@/lib/training/types";

const ROLE_OPTIONS = STAFF_ROLES.map((r) => ({ value: r.value, label: r.single }));

function InviteForm({ onDone }: { onDone: (message: string) => void }) {
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<StaffRole | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!role) {
      setFieldErrors({ role: "Choose a staff role." });
      return;
    }
    setLoading(true);
    const result = await inviteStaff({ phone, role });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
      return;
    }
    setPhone("");
    setRole("");
    onDone(`Invitation sent to ${result.data.member.phoneMasked}. They'll see it in Training once they sign in.`);
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5"
    >
      <h2 className="text-base font-semibold">Invite a staff member</h2>
      <p className="text-xs leading-relaxed text-muted-foreground">
        They need a Farm Korret account with this phone number verified. They&apos;ll see your invitation in Training
        and must accept before you can see their progress.
      </p>
      {error && <FormAlert>{error}</FormAlert>}
      <TextField
        name="phone"
        label="Phone number"
        icon="phone"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        placeholder="0812 345 6789"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        error={fieldErrors.phone}
        required
      />
      <SelectField
        name="role"
        label="Role"
        placeholder="Choose a role"
        options={ROLE_OPTIONS}
        value={role}
        onChange={(e) => setRole(e.target.value as StaffRole)}
        error={fieldErrors.role}
        required
      />
      <Button type="submit" loading={loading}>
        {loading ? "Sending…" : "Send invitation"}
      </Button>
    </form>
  );
}

function ProgramEditor({
  program,
  options,
  onDone,
}: {
  program: StaffProgram;
  options: ProgramCourse[];
  onDone: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>(program.courses.map((c) => c.id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = STAFF_ROLES.find((r) => r.value === program.role)!.label;

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const result = await saveProgram(program.role, selected);
    setSaving(false);
    if (!result.ok) {
      setError(result.fieldErrors?.courseIds ?? result.error);
      return;
    }
    setEditing(false);
    onDone(`${label} programme saved.`);
  }

  if (!editing)
    return (
      <div>
        {program.courses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No courses assigned yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {program.courses.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/8 text-[0.6875rem] font-semibold text-primary">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="text-[0.6875rem] text-muted-foreground">{c.lessonCount} lessons</span>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          onClick={() => {
            setSelected(program.courses.map((c) => c.id));
            setEditing(true);
          }}
          className="mt-3 flex items-center gap-1.5 rounded-full text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Icon name="pencil" className="size-4" />
          {program.courses.length ? "Change courses" : "Assign courses"}
        </button>
      </div>
    );

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">
        Choose up to {TRAINING_LIMITS.programCourses} courses for {label}
      </legend>
      {error && <FormAlert>{error}</FormAlert>}
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">There are no published courses to assign yet.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto rounded-2xl bg-foreground/3 p-2">
          {options.map((c) => {
            const checked = selected.includes(c.id);
            const full = !checked && selected.length >= TRAINING_LIMITS.programCourses;
            return (
              <li key={c.id}>
                <label
                  className={`flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm ${full ? "opacity-50" : "cursor-pointer hover:bg-white"}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={full}
                    onChange={() => toggle(c.id)}
                    className="size-4 accent-primary"
                  />
                  <span className="min-w-0 flex-1">{c.title}</span>
                  <span className="text-[0.6875rem] text-muted-foreground">{c.lessonCount} lessons</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {selected.length} selected. Courses are taken in the order you tick them.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-10 text-sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button type="button" className="h-10 text-sm" loading={saving} onClick={save}>
          Save programme
        </Button>
      </div>
    </fieldset>
  );
}

function MemberRow({ member, onDone }: { member: StaffMember; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState<"role" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const who = member.name ?? member.phoneMasked;

  async function move(role: StaffRole) {
    if (role === member.role) return;
    setBusy("role");
    setError(null);
    const result = await changeStaffRole(member.id, role);
    setBusy(null);
    if (!result.ok) return setError(result.error);
    onDone(`${who} moved to ${STAFF_ROLES.find((r) => r.value === role)!.single.toLowerCase()}.`);
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    const result = await removeStaff(member.id);
    setBusy(null);
    setConfirming(false);
    if (!result.ok) return setError(result.error);
    onDone(member.status === "active" ? `${who} was removed from your staff.` : "Invitation withdrawn.");
  }

  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{member.name ?? "Invitation sent"}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {member.phoneMasked} ·{" "}
            {member.acceptedAt ? `Joined ${formatDate(member.acceptedAt)}` : `Invited ${formatDate(member.invitedAt)}`}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${
            member.status === "active" ? "bg-accent/12 text-primary" : "bg-amber-50 text-amber-800"
          }`}
        >
          {member.status === "active" ? "Active" : "Awaiting reply"}
        </span>
      </div>

      {member.status === "active" &&
        (member.progress.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No courses in this role&apos;s programme yet.</p>
        ) : (
          <ul aria-label={`${who}'s progress`} className="mt-2 space-y-1">
            {member.progress.map((p) => (
              <li key={p.courseId} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">{p.title}</span>
                <span
                  className={`shrink-0 tabular-nums ${p.totalLessons > 0 && p.completedLessons === p.totalLessons ? "font-semibold text-primary" : "text-muted-foreground"}`}
                >
                  {p.completedLessons}/{p.totalLessons} lessons
                </span>
              </li>
            ))}
          </ul>
        ))}

      {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <label htmlFor={`role-${member.id}`} className="sr-only">
          Role for {who}
        </label>
        <select
          id={`role-${member.id}`}
          value={member.role}
          disabled={busy !== null}
          onChange={(e) => move(e.target.value as StaffRole)}
          className="h-9 min-w-0 flex-1 cursor-pointer rounded-full bg-foreground/4 px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={remove}
              disabled={busy !== null}
              className="h-9 rounded-full bg-red-600 px-3 text-xs font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              {busy === "remove" ? "Removing…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-9 rounded-full px-3 text-xs font-medium text-foreground/60 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy !== null}
            className="h-9 rounded-full px-3 text-xs font-medium text-red-600 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
          >
            {member.status === "active" ? "Remove" : "Withdraw"}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * Staff Training Programs for the owner's own farm. Every change goes to the
 * server, and the page is re-read from it afterwards: nothing here assumes a
 * change worked.
 */
export function StaffManager({ overview, options }: { overview: StaffOverview; options: ProgramCourse[] }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);

  function done(message: string) {
    setNotice(message);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div aria-live="polite">{notice && <FormAlert tone="success">{notice}</FormAlert>}</div>
      <InviteForm onDone={done} />
      {STAFF_ROLES.map((role) => {
        const program = overview.programs.find((p) => p.role === role.value) ?? { role: role.value, courses: [] };
        const members = overview.members.filter((m) => m.role === role.value);
        return (
          <section
            key={role.value}
            aria-labelledby={`role-${role.value}`}
            className="rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5"
          >
            <div className="p-4">
              <h2 id={`role-${role.value}`} className="text-base font-semibold">
                {role.label}
              </h2>
              <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
                {members.length === 0
                  ? "No one in this role yet"
                  : `${members.filter((m) => m.status === "active").length} active · ${members.filter((m) => m.status === "invited").length} awaiting reply`}
              </p>
              <ProgramEditor
                key={program.courses.map((c) => c.id).join()}
                program={program}
                options={options}
                onDone={done}
              />
            </div>
            {members.length > 0 && (
              <ul
                aria-label={`${role.label} staff`}
                className="divide-y divide-foreground/6 border-t border-foreground/6"
              >
                {members.map((m) => (
                  <MemberRow key={`${m.id}-${m.role}`} member={m} onDone={done} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
