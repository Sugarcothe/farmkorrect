"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createCase } from "@/lib/admin/api";
import type { CaseType } from "@/lib/admin/cases";

/**
 * Opens an internal case about a flagged record and goes to it. Opening a
 * case changes nothing about the record itself. When a case is already
 * open for it, the server says which one and this links there instead.
 */
export function OpenCaseButton({ type, sourceId }: { type: CaseType; sourceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    const res = await createCase({ type, sourceId });
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      setExisting(res.fieldErrors?.reference ?? null);
      return;
    }
    router.push(`/admin/cases/${res.data.case.reference}`);
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="rounded-full border border-primary/40 px-2.5 py-1 text-xs font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        {busy ? "Opening…" : "Open a case"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {existing ? (
            <Link href={`/admin/cases/${existing}`} className="underline">
              {error}
            </Link>
          ) : (
            error
          )}
        </span>
      )}
    </span>
  );
}
