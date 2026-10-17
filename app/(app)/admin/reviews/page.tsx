import type { Metadata } from "next";
import { AdminTabs, pageHref, pageParam } from "@/components/admin/admin-parts";
import { ReviewModeration } from "@/components/admin/review-moderation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { Stars, VerifiedBadge } from "@/components/reviews/stars";
import { EmptyList, first, formatDate, Pager } from "@/components/wallet/wallet-parts";
import type { ModerationStatus } from "@/lib/admin/types";
import { requireAdminPage } from "@/lib/server/admin";
import { isModerationStatus, listReviewsForModeration } from "@/lib/server/admin-reviews";

export const metadata: Metadata = { title: "Reviews" };

const TABS: { key: ModerationStatus; label: string; empty: string }[] = [
  { key: "pending", label: "Waiting", empty: "No reviews are waiting for moderation." },
  { key: "published", label: "Published", empty: "No published reviews." },
  { key: "rejected", label: "Rejected", empty: "No rejected or removed reviews." },
];

// Review moderation: reviews by status with the moves open to each. The
// rating and text are shown as written and can't be edited here.
export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireAdminPage();
  const query = await searchParams;
  const requested = first(query.status);
  const status: ModerationStatus = isModerationStatus(requested) ? requested : "pending";
  const page = pageParam(first(query.page));
  const { cases, hasMore } = await listReviewsForModeration(user._id, status, page);
  const filters = { status: status === "pending" ? null : status };

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Reviews" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <AdminTabs
          label="Review status"
          current={status}
          tabs={TABS.map((t) => ({ key: t.key, label: t.label, href: pageHref("/admin/reviews", { status: t.key === "pending" ? null : t.key }, 1) }))}
        />
        {cases.length ? (
          <ul aria-label="Reviews" className="space-y-3">
            {cases.map((r) => (
              <li key={r.id} className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
                <div>
                  <p className="truncate text-[0.9375rem] font-medium">{r.productName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    By {r.reviewerName} · {formatDate(r.createdAt, true)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Stars rating={r.rating} />
                  {r.verifiedPurchase && <VerifiedBadge />}
                </div>
                {r.text ? (
                  <p className="text-sm leading-relaxed whitespace-pre-line break-words text-foreground/80">{r.text}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Rating only, no text.</p>
                )}
                {r.conflict ? (
                  <p className="text-xs text-muted-foreground">
                    You sold this product or wrote this review, so another admin has to moderate it.
                  </p>
                ) : (
                  r.status !== "withdrawn" && (
                    <ReviewModeration reviewId={r.id} status={r.status} updatedAt={r.updatedAt} />
                  )
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyList icon="star" title={page > 1 ? "No more reviews" : "Nothing here"}>
            {TABS.find((t) => t.key === status)!.empty}
          </EmptyList>
        )}
        <Pager
          newer={page > 1 ? pageHref("/admin/reviews", filters, page - 1) : null}
          older={hasMore ? pageHref("/admin/reviews", filters, page + 1) : null}
        />
      </div>
    </main>
  );
}
