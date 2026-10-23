"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { changeRole, grantRole, lookupTeamCandidate } from "@/lib/admin/api";
import type { TeamCandidate, TeamMember } from "@/lib/admin/accounts";
import { ADMIN_ROLE_DESCRIPTIONS, ADMIN_ROLE_LABELS, ADMIN_ROLES, type AdminRole } from "@/lib/admin/permissions";
import { ADMIN_TEXT_LIMITS } from "@/lib/admin/types";
import { validateAdminReason } from "@/lib/admin/validation";
import { ROLE_LABELS } from "@/lib/auth/types";
import { cleanText } from "@/lib/profile/validation";

const card = "space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5";

function RolePicker({
  value,
  onChange,
  roles,
  error,
}: {
  value: AdminRole | "";
  onChange: (role: AdminRole) => void;
  roles: readonly AdminRole[];
  error?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">Role</legend>
      {roles.map((role) => (
        <label
          key={role}
          className={`flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-2.5 ring-1 ${value === role ? "bg-primary/5 ring-primary/40" : "ring-foreground/10"}`}
        >
          <input
            type="radio"
            name="role"
            value={role}
            checked={value === role}
            onChange={() => onChange(role)}
            className="mt-1 accent-primary"
          />
          <span>
            <span className="block text-sm font-medium">{ADMIN_ROLE_LABELS[role]}</span>
            <span className="block text-xs leading-snug text-muted-foreground">{ADMIN_ROLE_DESCRIPTIONS[role]}</span>
          </span>
        </label>
      ))}
      {error && (
        <p role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Finds an existing account (exact id, phone or email) and grants it an
 * admin role. Nothing is created: the account must already be active and
 * phone-verified. Only root admins are offered Super Admin.
 */
export function GrantRoleForm({ root }: { root: boolean }) {
  const router = useRouter();
  const roles = root ? ADMIN_ROLES : ADMIN_ROLES.filter((r) => r !== "super_admin");
  const [q, setQ] = useState("");
  const [candidate, setCandidate] = useState<TeamCandidate | null | undefined>(undefined);
  const [role, setRole] = useState<AdminRole | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"find" | "grant" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  async function find(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return setError("Enter a user id, phone number or email address.");
    setBusy("find");
    setError(null);
    setDone(null);
    const res = await lookupTeamCandidate(q.trim());
    setBusy(null);
    if (!res.ok) {
      setCandidate(undefined);
      setError(res.fieldErrors?.q ?? res.error);
      return;
    }
    setCandidate(res.data.candidate);
  }

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    if (!candidate) return;
    const errors: Record<string, string> = {};
    if (!role) errors.role = "Choose a role.";
    const reasonError = validateAdminReason(cleanText(reason, true));
    if (reasonError) errors.reason = reasonError;
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    setBusy("grant");
    setError(null);
    const res = await grantRole({
      userId: candidate.account.id,
      role: role as AdminRole,
      reason: cleanText(reason, true),
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      setFieldErrors(res.fieldErrors ?? {});
      return;
    }
    setDone(`${candidate.account.fullName} is now ${ADMIN_ROLE_LABELS[role as AdminRole]}.`);
    setCandidate(undefined);
    setQ("");
    setRole("");
    setReason("");
    router.refresh();
  }

  return (
    <section className={card} aria-labelledby="grant-heading">
      <h2 id="grant-heading" className="text-sm font-semibold">
        Give an account an admin role
      </h2>
      {done && <FormAlert tone="success">{done}</FormAlert>}
      <form onSubmit={find} noValidate className="space-y-3">
        <TextField
          name="q"
          label="User id, phone number or email"
          icon="search"
          autoComplete="off"
          hint="The person must already have an active, phone-verified account."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="outline" loading={busy === "find"}>
          Find account
        </Button>
      </form>
      {error && <FormAlert tone="error">{error}</FormAlert>}
      {candidate === null && (
        <p role="status" className="text-sm text-muted-foreground">
          No account matches that exactly.
        </p>
      )}
      {candidate && (
        <div className="space-y-3 border-t border-foreground/6 pt-3">
          <div>
            <p className="text-sm font-semibold">{candidate.account.fullName}</p>
            <p className="text-xs text-muted-foreground">
              {ROLE_LABELS[candidate.account.role]} · {candidate.account.phoneMasked}
              {candidate.account.emailMasked && ` · ${candidate.account.emailMasked}`}
            </p>
            {candidate.current && (
              <p className="mt-1 text-xs text-muted-foreground">
                Already {ADMIN_ROLE_LABELS[candidate.current.role]}
                {candidate.current.root ? " (root)" : ""}.
              </p>
            )}
          </div>
          {candidate.blocked ? (
            <p className="rounded-xl bg-foreground/[0.04] px-3.5 py-3 text-sm text-foreground/80">
              {candidate.blocked}
            </p>
          ) : (
            <form onSubmit={grant} noValidate className="space-y-3">
              <RolePicker value={role} onChange={setRole} roles={roles} error={fieldErrors.role} />
              <TextAreaField
                name="reason"
                label="Reason"
                hint="Recorded in the audit trail."
                maxLength={ADMIN_TEXT_LIMITS.reason.max + 50}
                value={reason}
                error={fieldErrors.reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button type="submit" loading={busy === "grant"}>
                Grant role
              </Button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

/** Changes or revokes one membership, against the version the page was loaded at. */
export function ChangeRoleForm({ member, root }: { member: TeamMember; root: boolean }) {
  const router = useRouter();
  const roles = root ? ADMIN_ROLES : ADMIN_ROLES.filter((r) => r !== "super_admin");
  const [role, setRole] = useState<AdminRole | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"change" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  async function submit(action: "change" | "revoke") {
    const errors: Record<string, string> = {};
    if (action === "change" && !role) errors.role = "Choose the new role.";
    const reasonError = validateAdminReason(cleanText(reason, true));
    if (reasonError) errors.reason = reasonError;
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    setBusy(action);
    setError(null);
    const expectedVersion = member.version ?? 0;
    const res = await changeRole(
      member.userId,
      action === "change"
        ? { action, role: role as AdminRole, reason: cleanText(reason, true), expectedVersion }
        : { action, reason: cleanText(reason, true), expectedVersion },
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      setFieldErrors(res.fieldErrors ?? {});
      router.refresh();
      return;
    }
    setDone(action === "change" ? `Role changed to ${ADMIN_ROLE_LABELS[role as AdminRole]}.` : "Admin role revoked.");
    router.refresh();
  }

  if (done) return <FormAlert tone="success">{done}</FormAlert>;

  if (member.role === "super_admin" && !root)
    return <p className="text-xs text-muted-foreground">Only a root admin can change or revoke a Super Admin.</p>;

  return (
    <form
      className={card}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit("change");
      }}
    >
      <h2 className="text-sm font-semibold">Change or revoke this role</h2>
      {error && <FormAlert tone="error">{error}</FormAlert>}
      <RolePicker
        value={role}
        onChange={setRole}
        roles={roles.filter((r) => r !== member.role)}
        error={fieldErrors.role}
      />
      <TextAreaField
        name="reason"
        label="Reason"
        hint="Recorded in the audit trail."
        maxLength={ADMIN_TEXT_LIMITS.reason.max + 50}
        value={reason}
        error={fieldErrors.reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-2">
        <Button type="submit" loading={busy === "change"}>
          Change role
        </Button>
        <Button type="button" variant="outline" loading={busy === "revoke"} onClick={() => void submit("revoke")}>
          Revoke role
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Revoking takes effect on their next request.</p>
    </form>
  );
}
