import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuditList, Facts, Pill } from "@/components/admin/admin-parts";
import { CredentialDecisionForm } from "@/components/admin/credential-decision";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { formatDate } from "@/components/wallet/wallet-parts";
import type { CredentialCase } from "@/lib/admin/types";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { getCredentialCase } from "@/lib/server/admin-credentials";

export const metadata: Metadata = { title: "Credential" };

const ROLE_LABELS = { veterinarian: "Veterinarian", "non-vet-specialist": "Specialist" } as const;

const STATUS: Record<CredentialCase["status"], { label: string; tone: "neutral" | "waiting" | "good" | "bad" }> = {
  not_submitted: { label: "Not submitted", tone: "neutral" },
  pending: { label: "Pending", tone: "waiting" },
  verified: { label: "Approved", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
};

// One professional's submitted credential, the decision form while it's
// pending, and every decision ever recorded for it.
export default async function CredentialPage({ params }: { params: Promise<{ userId: string }> }) {
  const { user } = await requireAdminCapabilityPage("admin.credentials.review");
  const { userId } = await params;
  const found = await getCredentialCase(userId);
  if (!found) notFound();
  const { case: c, history } = found;
  const own = user._id.toHexString() === c.userId;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Credential" back={<BackLink href="/admin/credentials" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <Facts
          label="Submitted details"
          rows={[
            ["Name", c.fullName],
            ["Role", ROLE_LABELS[c.role]],
            ["Status", <Pill key="s" tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Pill>],
            ["Registration number", c.registrationNumber || "Not given"],
            ["Specialization", c.specialization || "Not given"],
            ["Qualifications", c.qualifications || "Not given"],
            ["Location", c.location || "Not given"],
            ["Submitted", c.submittedAt ? formatDate(c.submittedAt, true) : "Not submitted"],
            ...(c.reviewedAt ? [["Last decided", formatDate(c.reviewedAt, true)] as [string, string]] : []),
          ]}
        />

        {c.status === "pending" && c.submittedAt && !own && (
          <CredentialDecisionForm userId={c.userId} submittedAt={c.submittedAt} />
        )}
        {c.status === "pending" && own && (
          <p className="text-sm text-muted-foreground">Another admin has to review your own credentials.</p>
        )}

        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-2 text-sm font-semibold">
            Review history
          </h2>
          {history.length ? (
            <AuditList entries={history} />
          ) : (
            <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}
