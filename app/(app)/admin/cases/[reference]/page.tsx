import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuditList, Facts, Pill, PRIORITY_TONE } from "@/components/admin/admin-parts";
import { CaseActions } from "@/components/admin/case-actions";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, formatDate } from "@/components/wallet/wallet-parts";
import {
  CASE_PRIORITY_LABELS,
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
  RESOLUTION_LABELS,
  type CaseResponse,
} from "@/lib/admin/cases";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { getCase } from "@/lib/server/admin-cases";
import { HttpError } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

export const metadata: Metadata = { title: "Case" };

// One case: what it's about (read live from the source, safe fields only),
// its append-only notes, the actions this admin's role allows, and its
// audit history. A case of a type the admin can't see is a 404.
export default async function CasePage({ params }: { params: Promise<{ reference: string }> }) {
  const access = await requireAdminCapabilityPage("admin.cases.read");
  await limitUser("adminReadsPerUser", access.user._id);
  let found: CaseResponse;
  try {
    found = await getCase(access, (await params).reference);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }
  const { case: c, permissions, assignees } = found;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={c.reference} back={<BackLink href="/admin/cases" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <header>
          <div className="flex flex-wrap gap-1.5">
            <Pill tone={PRIORITY_TONE[c.priority]}>{CASE_PRIORITY_LABELS[c.priority]}</Pill>
            <Pill tone={c.status === "resolved" ? "good" : "neutral"}>{CASE_STATUS_LABELS[c.status]}</Pill>
            <Pill>{CASE_TYPE_LABELS[c.type]}</Pill>
          </div>
          <h1 className="mt-2 text-lg font-semibold break-words">{c.title}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Opened {formatDate(c.createdAt, true)} by {c.createdByName ?? "a removed account"} ·{" "}
            {c.assignee ? `Assigned to ${c.assignee.name}` : "Unassigned"} · Version {c.version}
          </p>
        </header>

        <section aria-labelledby="source-heading" className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 id="source-heading" className="text-sm font-semibold">
              {c.source?.label ?? "Source"}
            </h2>
            {c.source?.href && (
              <Link href={c.source.href} className="text-sm font-medium text-primary hover:underline">
                Open
              </Link>
            )}
          </div>
          {c.source ? (
            <Facts label="What this case is about" rows={c.source.facts} />
          ) : (
            <p className="rounded-xl bg-foreground/[0.04] px-3.5 py-3 text-sm text-muted-foreground">
              The record ({c.sourceId}) couldn&apos;t be found any more.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Read live from the record. This case never changes it.</p>
        </section>

        {c.resolution && (
          <Facts
            label="Outcome"
            rows={[
              ["Outcome", RESOLUTION_LABELS[c.resolution.code]],
              ["Closed", `${formatDate(c.resolution.at, true)} by ${c.resolution.byName ?? "a removed account"}`],
              ["Note", c.resolution.note],
            ]}
          />
        )}

        <CaseActions
          detail={c}
          permissions={permissions}
          assignees={assignees}
          viewerId={access.user._id.toHexString()}
          canManage={access.can("admin.cases.manage")}
        />

        <section aria-labelledby="notes-heading">
          <h2 id="notes-heading" className="mb-2 text-sm font-semibold">
            Notes
          </h2>
          {c.notes.length === 0 ? (
            <EmptyList icon="file-text" title="No notes yet">
              Notes are internal and can&apos;t be edited or removed.
            </EmptyList>
          ) : (
            <ol className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
              {c.notes.map((n) => (
                <li key={n.id} className="px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    {n.authorName ?? "A removed account"} · <time dateTime={n.at}>{formatDate(n.at, true)}</time>
                  </p>
                  <p className="mt-1 text-sm whitespace-pre-line break-words">{n.body}</p>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-2 text-sm font-semibold">
            History
          </h2>
          {c.history.length ? (
            <AuditList entries={c.history} />
          ) : (
            <EmptyList icon="shield-check" title="No history">
              Changes to this case are recorded here.
            </EmptyList>
          )}
        </section>
      </div>
    </main>
  );
}
