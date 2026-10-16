import { EmptyList, formatDate, Pager } from "@/components/wallet/wallet-parts";
import type { PublicReview, ReviewEligibility, ReviewSummary } from "@/lib/reviews/types";
import { ReviewComposer } from "./review-composer";
import { Stars, VerifiedBadge } from "./stars";

// The Reviews part of a product page: the rating summary and distribution,
// the viewer's own review options, and published reviews newest first.
// Everything shown is read from the reviews collection on each request.

function Summary({ summary }: { summary: ReviewSummary }) {
  const { average, count, distribution } = summary;
  return (
    <div className="flex items-center gap-5">
      <div className="text-center">
        <p className="text-4xl font-bold tabular-nums">{average === null ? "–" : average.toFixed(1)}</p>
        <Stars rating={average ?? 0} className="size-3.5" />
        <p className="mt-1 text-xs text-muted-foreground">
          {count} review{count === 1 ? "" : "s"}
        </p>
      </div>
      <ul aria-label="Ratings breakdown" className="flex-1 space-y-1">
        {distribution.map(({ stars, count: n }) => (
          <li key={stars} className="flex items-center gap-2 text-xs">
            <span className="w-3 text-right tabular-nums text-muted-foreground">{stars}</span>
            <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/8">
              <span className="block h-full rounded-full bg-amber-400" style={{ width: count ? `${(n / count) * 100}%` : 0 }} />
            </span>
            <span className="w-6 tabular-nums text-muted-foreground">{n}</span>
            <span className="sr-only">
              {n} review{n === 1 ? "" : "s"} gave {stars} star{stars === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewItem({ review }: { review: PublicReview }) {
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{review.reviewerName}</span>
        <Stars rating={review.rating} />
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
        {review.editedAt && <span>· edited</span>}
        {review.verifiedPurchase && <VerifiedBadge />}
      </p>
      <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-foreground/80">{review.text}</p>
    </li>
  );
}

export function ProductReviews({
  productId,
  summary,
  reviews,
  page,
  hasMore,
  viewer,
}: {
  productId: string;
  summary: ReviewSummary;
  reviews: PublicReview[];
  page: number;
  hasMore: boolean;
  viewer: ReviewEligibility;
}) {
  const href = (n: number) => `/market/${productId}${n > 1 ? `?reviews=${n}` : ""}#reviews`;
  return (
    <section id="reviews" aria-labelledby="reviews-title" className="space-y-4 scroll-mt-16">
      <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-foreground/5">
        <h2 id="reviews-title" className="mb-4 text-base font-semibold">
          Reviews
        </h2>
        <Summary summary={summary} />
        <div className="mt-5 border-t border-foreground/6 pt-4">
          <ReviewComposer productId={productId} viewer={viewer} />
        </div>
      </div>

      {reviews.length === 0 ? (
        page === 1 && (
          <EmptyList icon="star" title="No reviews yet">
            Reviews appear here once customers who bought and received this product share their experience.
          </EmptyList>
        )
      ) : (
        <ul aria-label="Customer reviews" className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
          {reviews.map((review) => (
            <ReviewItem key={review.id} review={review} />
          ))}
        </ul>
      )}
      <Pager newer={page > 1 ? href(page - 1) : null} older={hasMore ? href(page + 1) : null} />
    </section>
  );
}

/** Shown in place of the reviews when they couldn't be read; the product itself still loads. */
export function ReviewsUnavailable({ productId }: { productId: string }) {
  return (
    <section id="reviews" role="alert" className="rounded-3xl bg-white p-5 text-center shadow-sm ring-1 ring-foreground/5">
      <h2 className="text-base font-semibold">Reviews</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        We couldn&apos;t load the reviews right now.{" "}
        <a href={`/market/${productId}#reviews`} className="font-medium text-primary underline-offset-2 hover:underline">
          Try again
        </a>
      </p>
    </section>
  );
}
