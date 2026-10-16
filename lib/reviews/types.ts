// Shapes the product review API sends and accepts. The browser only ever
// sends a rating and the review text: the product comes from the URL, and
// the reviewer, order, status and "verified purchase" flag are decided on
// the server from the signed-in account and its delivered orders.

export const REVIEW_LIMITS = {
  rating: { min: 1, max: 5 },
  text: { min: 10, max: 1_000 },
  pageSize: 10,
} as const;

/**
 * - pending: waiting for a person to check it (not shown publicly)
 * - published: shown on the product and counted in its rating
 * - rejected: removed by moderation; can't be edited or reposted
 * - withdrawn: taken down by its author, who may write a new one
 */
export type ReviewStatus = "pending" | "published" | "rejected" | "withdrawn";

export const RATING_WORDS = ["Poor", "Fair", "Good", "Very good", "Excellent"] as const;

/** A published review, as anyone viewing the product sees it. */
export type PublicReview = {
  id: string;
  /** first name and last initial; nothing else about the reviewer is shared */
  reviewerName: string;
  rating: number;
  text: string;
  verifiedPurchase: boolean;
  createdAt: string;
  /** null unless the author changed it after posting */
  editedAt: string | null;
};

/** Published reviews only. `average` is rounded to one decimal place, or null when there are none. */
export type ReviewSummary = {
  count: number;
  average: number | null;
  /** how many published reviews gave each rating, 5 stars first */
  distribution: { stars: number; count: number }[];
};

/** A review as its author sees it. */
export type MyReview = {
  id: string;
  productId: string;
  productName: string;
  /** whether the product is still listed, so it can be linked to */
  productListed: boolean;
  rating: number;
  text: string;
  status: ReviewStatus;
  verifiedPurchase: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
};

/** What the signed-in user can do about reviewing a product. No order details are included. */
export type ReviewEligibility =
  | { state: "eligible" }
  | { state: "reviewed"; review: MyReview }
  | { state: "own_product" }
  | { state: "awaiting_delivery" }
  | { state: "not_purchased" };

export type ReviewInput = { rating: number; text: string };

export type ProductReviewsResponse = {
  summary: ReviewSummary;
  reviews: PublicReview[];
  page: number;
  hasMore: boolean;
  viewer: ReviewEligibility;
};
export type ReviewResponse = { review: MyReview };
export type MyReviewsResponse = { reviews: MyReview[]; page: number; hasMore: boolean };
