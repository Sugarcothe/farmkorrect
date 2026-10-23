import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountStatusForm } from "@/components/admin/account-status-form";
import { AuditList, Facts, Pill } from "@/components/admin/admin-parts";
import { OpenCaseButton } from "@/components/admin/open-case-button";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, formatDate } from "@/components/wallet/wallet-parts";
import { ACCOUNT_STATUS_LABELS } from "@/lib/admin/accounts";
import { ADMIN_ROLE_LABELS } from "@/lib/admin/permissions";
import { ROLE_LABELS } from "@/lib/auth/types";
import { isRootAdminId, requireAdminCapabilityPage } from "@/lib/server/admin";
import { getAccountDetail } from "@/lib/server/admin-accounts";
import { openCaseLinks } from "@/lib/server/admin-cases";
import { limitUser } from "@/lib/server/order-access";

export const metadata: Metadata = { title: "Account" };

// One account as an admin sees it: masked contact details, status, admin
// role, activity counts and history, plus suspend or reactivate for roles
// that may. Nothing else about the account can be changed here.
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireAdminCapabilityPage("admin.users.read");
  await limitUser("adminUserLookupsPerUser", access.user._id);
  const { id } = await params;
  const account = await getAccountDetail(id);
  if (!account) notFound();
  const self = access.user._id.toHexString() === account.id;
  const root = isRootAdminId(account.id);
  const canChange = access.can("admin.users.suspend") && !self && !root;
  const canOpenCase =
    access.can("admin.cases.read") && (access.can("admin.cases.manage") || access.can("admin.cases.assign"));
  const openCase = (await openCaseLinks("account", [account.id])).get(account.id) ?? null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={account.fullName} back={<BackLink href="/admin/users" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <div className="flex flex-wrap gap-1.5">
          <Pill tone={account.status === "active" ? "good" : account.status === "suspended" ? "bad" : "waiting"}>
            {ACCOUNT_STATUS_LABELS[account.status]}
          </Pill>
          {account.admin && (
            <Pill>
              {ADMIN_ROLE_LABELS[account.admin.role]}
              {account.admin.root ? " (root)" : ""}
            </Pill>
          )}
        </div>
        <Facts
          label="Account"
          rows={[
            ["Name", account.fullName],
            ["Role", ROLE_LABELS[account.role]],
            ["Phone", `${account.phoneMasked}${account.phoneVerified ? " (verified)" : " (not verified)"}`],
            ["Email", account.emailMasked || "None"],
            ["Joined", formatDate(account.createdAt)],
            ["User id", account.id],
            [
              "Last status change",
              account.suspension
                ? `${account.suspension.state === "suspended" ? "Suspended" : "Reactivated"} ${formatDate(account.suspension.at, true)} by ${account.suspension.byName ?? "a removed account"}`
                : "None",
            ],
            ["Orders", `${account.activity.ordersAsBuyer} as buyer · ${account.activity.ordersAsSeller} as seller`],
          ]}
        />

        {canOpenCase && (
          <div className="flex items-center justify-between gap-3 rounded-3xl bg-white px-4 py-3 shadow-sm ring-1 ring-foreground/5">
            <span className="text-sm">Account case</span>
            {openCase ? (
              <Link
                href={`/admin/cases/${openCase.reference}`}
                className="text-sm font-medium text-primary hover:underline"
              >
                {openCase.reference}
              </Link>
            ) : (
              <OpenCaseButton type="account" sourceId={account.id} />
            )}
          </div>
        )}

        {canChange && (account.status === "active" || account.status === "suspended") && (
          <AccountStatusForm
            userId={account.id}
            action={account.status === "active" ? "suspend" : "reactivate"}
            expectedVersion={account.statusVersion}
          />
        )}
        {access.can("admin.users.suspend") && (self || root) && (
          <p className="text-xs text-muted-foreground">
            {self
              ? "You can't change your own account's status."
              : "Root admins are managed in server configuration and can't be suspended here."}
          </p>
        )}

        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-2 text-sm font-semibold">
            Account history
          </h2>
          {account.history.length ? (
            <AuditList entries={account.history} />
          ) : (
            <EmptyList icon="shield-check" title="No admin actions">
              Suspensions and reactivations are recorded here.
            </EmptyList>
          )}
        </section>
      </div>
    </main>
  );
}
