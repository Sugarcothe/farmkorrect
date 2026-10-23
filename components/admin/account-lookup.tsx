"use client";

import { useState } from "react";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { lookupAccount } from "@/lib/admin/api";
import { ACCOUNT_STATUS_LABELS, type AccountSummary } from "@/lib/admin/accounts";
import { ROLE_LABELS } from "@/lib/auth/types";

/**
 * Finds one account by its exact user id, phone number or email address.
 * The search is sent in a POST body (never the URL), is rate limited, and
 * the answer carries masked contact details only.
 */
export function AccountLookup() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AccountSummary | null | undefined>(undefined);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return setError("Enter a user id, phone number or email address.");
    setBusy(true);
    setError(null);
    const res = await lookupAccount(q.trim());
    setBusy(false);
    if (!res.ok) {
      setResult(undefined);
      setError(res.fieldErrors?.q ?? res.error);
      return;
    }
    setResult(res.data.account);
  }

  return (
    <div className="space-y-3">
      <form
        onSubmit={submit}
        noValidate
        className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5"
      >
        <TextField
          name="q"
          label="User id, phone number or email"
          icon="search"
          autoComplete="off"
          hint="Exact matches only."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {error && <FormAlert tone="error">{error}</FormAlert>}
        <Button type="submit" loading={busy}>
          Find account
        </Button>
      </form>
      {result === null && (
        <p role="status" className="rounded-xl bg-foreground/[0.04] px-3.5 py-3 text-sm text-muted-foreground">
          No account matches that exactly.
        </p>
      )}
      {result && (
        <Link
          href={`/admin/users/${result.id}`}
          className="block rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5 outline-none hover:bg-primary/[0.03] focus-visible:ring-2 focus-visible:ring-accent"
        >
          <p className="text-sm font-semibold">{result.fullName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ROLE_LABELS[result.role]} · {ACCOUNT_STATUS_LABELS[result.status]} · {result.phoneMasked}
            {result.emailMasked && ` · ${result.emailMasked}`}
          </p>
        </Link>
      )}
    </div>
  );
}
