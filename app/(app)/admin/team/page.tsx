import type { Metadata } from "next";
import { CaseLink, Pill } from "@/components/admin/admin-parts";
import { GrantRoleForm } from "@/components/admin/team-forms";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, formatDate, ListCard } from "@/components/wallet/wallet-parts";
import { ADMIN_CAPABILITY_LABELS, ADMIN_ROLE_LABELS, ADMIN_ROLES, ROLE_CAPABILITIES } from "@/lib/admin/permissions";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { getTeam } from "@/lib/server/admin-team";
import { limitUser } from "@/lib/server/order-access";

export const metadata: Metadata = { title: "Admin team" };

// Who holds which admin role (Super Admins only). Root admins come from
// ADMIN_USER_IDS in server configuration and can't be changed here.
export default async function TeamPage() {
  const access = await requireAdminCapabilityPage("admin.team.manage");
  await limitUser("adminReadsPerUser", access.user._id);
  const team = await getTeam();

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Admin team" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <section aria-labelledby="members-heading">
          <h2 id="members-heading" className="mb-2 text-sm font-semibold">
            Admins
          </h2>
          <ListCard label="Admins">
            {team.members.map((m) => (
              <CaseLink key={m.userId} href={`/admin/team/${m.userId}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{m.fullName}</p>
                  <Pill tone={m.root ? "good" : "neutral"}>
                    {ADMIN_ROLE_LABELS[m.role]}
                    {m.root ? " · root" : ""}
                  </Pill>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {m.root
                    ? "From server configuration"
                    : `Granted ${m.grantedAt ? formatDate(m.grantedAt) : ""} by ${m.grantedByName ?? "a removed account"}`}
                </p>
              </CaseLink>
            ))}
          </ListCard>
        </section>

        <GrantRoleForm root={access.root} />

        <section aria-labelledby="revoked-heading">
          <h2 id="revoked-heading" className="mb-2 text-sm font-semibold">
            Recently revoked
          </h2>
          {team.revoked.length === 0 ? (
            <EmptyList icon="shield-check" title="None revoked">
              Revoked roles are kept here and in the audit trail.
            </EmptyList>
          ) : (
            <ListCard label="Revoked roles">
              {team.revoked.map((r) => (
                <CaseLink key={r.membershipId} href={`/admin/team/${r.userId}`}>
                  <p className="text-sm font-medium">{r.fullName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Was {ADMIN_ROLE_LABELS[r.role]} · revoked {formatDate(r.revokedAt)} by{" "}
                    {r.revokedByName ?? "a removed account"}
                  </p>
                </CaseLink>
              ))}
            </ListCard>
          )}
        </section>

        <details className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
          <summary className="cursor-pointer text-sm font-semibold">What each role can do</summary>
          <dl className="mt-3 space-y-3">
            {ADMIN_ROLES.map((role) => (
              <div key={role}>
                <dt className="text-sm font-medium">{ADMIN_ROLE_LABELS[role]}</dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">
                  {ROLE_CAPABILITIES[role].map((c) => ADMIN_CAPABILITY_LABELS[c]).join(" · ")}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </main>
  );
}
