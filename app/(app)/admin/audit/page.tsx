import type { Metadata } from "next";
import Link from "next/link";
import { AuditList, pageHref, pageParam } from "@/components/admin/admin-parts";
import { FormAlert } from "@/components/auth/auth-screen";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { EmptyList, first, Pager } from "@/components/wallet/wallet-parts";
import { ADMIN_ACTION_LABELS, ADMIN_ACTIONS, AUDIT_TARGET_TYPES } from "@/lib/admin/types";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { listAudit, parseAuditFilters, type AuditFilters } from "@/lib/server/admin-audit";
import { HttpError } from "@/lib/server/http";

export const metadata: Metadata = { title: "Audit trail" };

const FILTER_KEYS = ["action", "targetType", "targetId", "actor"] as const;

const fieldClass =
  "h-11 w-full rounded-xl bg-white px-3 text-sm shadow-sm ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-accent";

// The admin audit trail, newest first, with filters. Read only: records
// can't be edited or deleted from the app.
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminCapabilityPage("admin.audit.read");
  const query = await searchParams;
  const raw = Object.fromEntries(FILTER_KEYS.map((key) => [key, first(query[key])?.trim() || null])) as Record<
    (typeof FILTER_KEYS)[number],
    string | null
  >;
  const page = pageParam(first(query.page));

  let filters: AuditFilters | null = null;
  let filterError: string | null = null;
  try {
    filters = parseAuditFilters(new URLSearchParams(Object.entries(raw).filter((e): e is [string, string] => !!e[1])));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    filterError = Object.values(error.fieldErrors ?? {})[0] ?? error.message;
  }
  const result = filters ? await listAudit(filters, page) : null;
  const filtered = Object.values(raw).some(Boolean);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Audit trail" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <form method="get" action="/admin/audit" className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Filter the audit trail">
          <label className="text-xs font-medium text-muted-foreground">
            Action
            <select name="action" defaultValue={raw.action ?? ""} className={`${fieldClass} mt-1`}>
              <option value="">Any action</option>
              {ADMIN_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ADMIN_ACTION_LABELS[a]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Target type
            <select name="targetType" defaultValue={raw.targetType ?? ""} className={`${fieldClass} mt-1`}>
              <option value="">Any target</option>
              {AUDIT_TARGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "user" ? "User (credential)" : t === "order" ? "Order (issue)" : "Review"}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Target id or order number
            <input name="targetId" defaultValue={raw.targetId ?? ""} placeholder="e.g. FKO-…" className={`${fieldClass} mt-1`} />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Admin user id
            <input name="actor" defaultValue={raw.actor ?? ""} className={`${fieldClass} mt-1`} />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:col-span-2">
            <Link href="/admin/audit" className={buttonClasses("outline", "h-11 text-sm")}>
              Clear
            </Link>
            <button type="submit" className={buttonClasses("solid", "h-11 text-sm")}>
              Filter
            </button>
          </div>
        </form>

        {filterError && <FormAlert tone="error">{filterError}</FormAlert>}

        {result &&
          (result.entries.length ? (
            <AuditList entries={result.entries} showTarget />
          ) : (
            <EmptyList icon="shield-check" title={filtered ? "No matching records" : "No admin actions yet"}>
              {filtered
                ? "Nothing in the audit trail matches these filters."
                : "Decisions on credentials, order issues and reviews are recorded here as they happen."}
            </EmptyList>
          ))}
        {result && (
          <Pager
            newer={page > 1 ? pageHref("/admin/audit", raw, page - 1) : null}
            older={result.hasMore ? pageHref("/admin/audit", raw, page + 1) : null}
          />
        )}
      </div>
    </main>
  );
}
