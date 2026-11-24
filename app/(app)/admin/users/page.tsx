import type { Metadata } from "next";
import { AccountLookup } from "@/components/admin/account-lookup";
import { AdminTable, pageHref, pageParam } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, formatDate, Pager } from "@/components/wallet/wallet-parts";
import { ROLE_LABELS } from "@/lib/auth/types";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { listSuspendedAccounts } from "@/lib/server/admin-accounts";
import { limitUser } from "@/lib/server/order-access";

export const metadata: Metadata = { title: "Accounts" };

// Account lookup (one exact match at a time, never a browse of users) and
// the list of suspended accounts.
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAdminCapabilityPage("admin.users.read");
  await limitUser("adminReadsPerUser", access.user._id);
  const page = pageParam(first((await searchParams).page));
  const suspended = await listSuspendedAccounts(page);

  return (
    <main data-wide className="flex flex-1 flex-col">
      <ProfileTopBar title="Accounts" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <AccountLookup />
        <section aria-labelledby="suspended-heading">
          <h2 id="suspended-heading" className="mb-2 text-sm font-semibold">
            Suspended accounts
          </h2>
          {suspended.accounts.length === 0 ? (
            <EmptyList icon="check-circle" title={page > 1 ? "No more accounts" : "None suspended"}>
              Accounts an admin suspends are listed here until they&apos;re reactivated.
            </EmptyList>
          ) : (
            <AdminTable
              label="Suspended accounts"
              rows={suspended.accounts}
              rowKey={(a) => a.id}
              href={(a) => `/admin/users/${a.id}`}
              columns={[
                { header: "Name", cell: (a) => <span className="font-medium">{a.fullName}</span> },
                { header: "Role", cell: (a) => ROLE_LABELS[a.role] },
                { header: "Phone", cell: (a) => a.phoneMasked, className: "whitespace-nowrap tabular-nums" },
                {
                  header: "Joined",
                  cell: (a) => formatDate(a.createdAt),
                  className: "whitespace-nowrap text-muted-foreground",
                },
              ]}
              card={(a) => (
                <>
                  <p className="text-sm font-medium">{a.fullName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ROLE_LABELS[a.role]} · {a.phoneMasked} · Joined {formatDate(a.createdAt)}
                  </p>
                </>
              )}
            />
          )}
          <Pager
            newer={page > 1 ? pageHref("/admin/users", {}, page - 1) : null}
            older={suspended.hasMore ? pageHref("/admin/users", {}, page + 1) : null}
          />
        </section>
        <p className="text-xs leading-relaxed text-muted-foreground">
          There is no impersonation, password access or account deletion here. Passwords, codes, sessions, bank details
          and payment data are never shown.
        </p>
      </div>
    </main>
  );
}
