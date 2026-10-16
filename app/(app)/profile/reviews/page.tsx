import type { Metadata } from "next";
import Link from "next/link";
import { pageNumber } from "@/components/orders/order-list-page";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { MyReviewItem } from "@/components/reviews/my-review-item";
import { buttonClasses } from "@/components/ui/button";
import { EmptyList, Pager } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { listMyReviews } from "@/lib/server/reviews";

export const metadata: Metadata = { title: "My Reviews" };

// The reviews the signed-in user has written, read from the database, with
// their moderation status. Editing and withdrawing happen in place.
export default async function MyReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const page = pageNumber((await searchParams).page);
  const { reviews, hasMore } = await listMyReviews(user._id, page);
  const href = (n: number) => (n > 1 ? `/profile/reviews?page=${n}` : "/profile/reviews");

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="My Reviews" back={<BackLink href="/profile" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        {reviews.length === 0 ? (
          page === 1 ? (
            <>
              <EmptyList icon="star" title="No reviews yet">
                Once an order from the Market is delivered, you can review what you bought on the product&apos;s page.
              </EmptyList>
              <Link href="/orders" className={buttonClasses("outline", "mt-4")}>
                Go to My Orders
              </Link>
            </>
          ) : (
            <EmptyList icon="star" title="Nothing on this page">
              <Link href="/profile/reviews" className="font-medium text-primary">
                Back to your latest reviews
              </Link>
            </EmptyList>
          )
        ) : (
          <ul aria-label="Your reviews" className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
            {reviews.map((review) => (
              <MyReviewItem key={review.id} review={review} />
            ))}
          </ul>
        )}
        <Pager newer={page > 1 ? href(page - 1) : null} older={hasMore ? href(page + 1) : null} />
      </div>
    </main>
  );
}
