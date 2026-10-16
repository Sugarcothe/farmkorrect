import type { ReviewStatus } from "@/lib/reviews/types";

// How each moderation status is described to the review's author.

const TONES = {
  neutral: "bg-foreground/6 text-foreground/65",
  waiting: "bg-amber-50 text-amber-800",
  good: "bg-accent/12 text-primary",
  bad: "bg-red-50 text-red-700",
} as const;

const STATUS: Record<ReviewStatus, { label: string; tone: keyof typeof TONES }> = {
  published: { label: "Published", tone: "good" },
  pending: { label: "Awaiting review", tone: "waiting" },
  rejected: { label: "Removed", tone: "bad" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export const STATUS_NOTE: Record<ReviewStatus, string | null> = {
  published: null,
  pending: "Our team is checking this review. It isn't shown on the product until it's approved.",
  rejected: "This review was removed by moderation and isn't shown on the product.",
  withdrawn: "You withdrew this review. It isn't shown. You can write a new one from the product's page.",
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${TONES[tone]}`}>{label}</span>
  );
}
