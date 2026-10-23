import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuditList, Facts } from "@/components/admin/admin-parts";
import { ChangeRoleForm } from "@/components/admin/team-forms";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, formatDate } from "@/components/wallet/wallet-parts";
import { ADMIN_ROLE_LABELS } from "@/lib/admin/permissions";
import { ROLE_LABELS } from "@/lib/auth/types";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { getTeamMember } from "@/lib/server/admin-team";
import { limitUser } from "@/lib/server/order-access";

export const metadata: Metadata = { title: "Admin role" };

// One account's admin role and its grant, change and revoke history.
export default async function TeamMemberPage({ params }: { params: Promise<{ userId: string }> }) {
  const access = await requireAdminCapabilityPage("admin.team.manage");
  await limitUser("adminReadsPerUser", access.user._id);
  const found = await getTeamMember((await params).userId);
  if (!found) notFound();
  const { member, account, history } = found;
  const self = access.user._id.toHexString() === account.id;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={account.fullName} back={<BackLink href="/admin/team" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <Facts
          label="Admin role"
          rows={[
            ["Account", `${account.fullName} · ${ROLE_LABELS[account.role]}`],
            ["Phone", account.phoneMasked],
            ["Admin role", member ? `${ADMIN_ROLE_LABELS[member.role]}${member.root ? " (root)" : ""}` : "None"],
            [
              "Granted",
              member?.root
                ? "From server configuration (ADMIN_USER_IDS)"
                : member?.grantedAt
                  ? `${formatDate(member.grantedAt, true)} by ${member.grantedByName ?? "a removed account"}`
                  : "—",
            ],
          ]}
        />
        {access.can("admin.users.read") && (
          <Link href={`/admin/users/${account.id}`} className="text-sm font-medium text-primary hover:underline">
            View account
          </Link>
        )}
        {member && !member.root && !self && <ChangeRoleForm member={member} root={access.root} />}
        {member && (member.root || self) && (
          <p className="text-xs text-muted-foreground">
            {member.root
              ? "Root admins are managed in server configuration and can't be changed here."
              : "You can't change your own admin role."}
          </p>
        )}
        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-2 text-sm font-semibold">
            Role history
          </h2>
          {history.length ? (
            <AuditList entries={history} />
          ) : (
            <EmptyList icon="shield-check" title="No history">
              Grants, changes and revocations are recorded here.
            </EmptyList>
          )}
        </section>
      </div>
    </main>
  );
}
