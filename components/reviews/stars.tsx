import { Icon } from "@/components/ui/icons";

/** A read-only row of five stars. Screen readers get the number instead. */
export function Stars({ rating, className = "size-4" }: { rating: number; className?: string }) {
  const filled = Math.round(rating);
  return (
    <span role="img" aria-label={`${rating} out of 5 stars`} className="inline-flex shrink-0 items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon
          key={n}
          name="star"
          className={`${className} ${n <= filled ? "fill-amber-400 text-amber-400" : "text-foreground/20"}`}
        />
      ))}
    </span>
  );
}

/** "Verified purchase": the review rests on a paid order that was delivered. */
export function VerifiedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[0.6875rem] font-semibold text-primary">
      <Icon name="check-circle" className="size-3" />
      Verified purchase
    </span>
  );
}
