import type { Metadata } from "next";
import { AccountLookup } from "@/components/admin/account-lookup";
import { CaseLink, pageHref, pageParam } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, formatDate, ListCard, Pager } from "@/components/wallet/wallet-parts";
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
    <main className="flex flex-1 flex-col">
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
            <ListCard label="Suspended accounts">
              {suspended.accounts.map((a) => (
                <CaseLink key={a.id} href={`/admin/users/${a.id}`}>
                  <p className="text-sm font-medium">{a.fullName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ROLE_LABELS[a.role]} · {a.phoneMasked} · Joined {formatDate(a.createdAt)}
                  </p>
                </CaseLink>
              ))}
            </ListCard>
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
