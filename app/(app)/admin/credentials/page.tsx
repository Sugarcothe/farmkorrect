import type { Metadata } from "next";
import { CaseLink, pageHref, pageParam } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, formatDate, ListCard, Pager } from "@/components/wallet/wallet-parts";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { listPendingCredentials } from "@/lib/server/admin-credentials";

export const metadata: Metadata = { title: "Credentials" };

const ROLE_LABELS = { veterinarian: "Veterinarian", "non-vet-specialist": "Specialist" } as const;

// Professionals waiting for a credential decision, oldest submission first.
export default async function CredentialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminCapabilityPage("admin.credentials.review");
  const page = pageParam(first((await searchParams).page));
  const { cases, hasMore } = await listPendingCredentials(page);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Credentials" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        {cases.length ? (
          <ListCard label="Credentials to review">
            {cases.map((c) => (
              <CaseLink key={c.userId} href={`/admin/credentials/${c.userId}`}>
                <p className="truncate text-[0.9375rem] font-medium">{c.fullName}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {ROLE_LABELS[c.role]} · Reg. {c.registrationNumber}
                </p>
                {c.submittedAt && (
                  <p className="mt-0.5 text-xs text-muted-foreground">Submitted {formatDate(c.submittedAt, true)}</p>
                )}
              </CaseLink>
            ))}
          </ListCard>
        ) : (
          <EmptyList icon="award" title={page > 1 ? "No more submissions" : "Nothing to review"}>
            When a veterinarian or specialist submits their registration details, they&apos;ll wait here for a decision.
          </EmptyList>
        )}
        <Pager
          newer={page > 1 ? pageHref("/admin/credentials", {}, page - 1) : null}
          older={hasMore ? pageHref("/admin/credentials", {}, page + 1) : null}
        />
      </div>
    </main>
  );
}
