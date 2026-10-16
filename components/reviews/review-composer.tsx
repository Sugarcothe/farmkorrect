"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { createReview, updateReview } from "@/lib/reviews/api";
import type { ReviewEligibility } from "@/lib/reviews/types";
import { ReviewForm } from "./review-form";
import { Stars } from "./stars";
import { STATUS_NOTE } from "./review-status";

/**
 * "Write a review" on a product page, shown only when the server says the
 * signed-in user may review it; otherwise it explains why not. After a save
 * the page is re-read from the server, so the list and summary show what
 * was actually stored.
 */
export function ReviewComposer({ productId, viewer }: { productId: string; viewer: ReviewEligibility }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const done = (message: string) => {
    setOpen(false);
    setSaved(message);
    router.refresh();
  };

  if (viewer.state === "own_product")
    return <p className="text-sm leading-relaxed text-muted-foreground">You can&apos;t review your own listing.</p>;
  if (viewer.state === "not_purchased")
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        Only customers who bought this product and received it can review it.
      </p>
    );
  if (viewer.state === "awaiting_delivery")
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        You can review this product once the seller marks your order as delivered.
      </p>
    );

  if (viewer.state === "reviewed") {
    const review = viewer.review;
    const editable = review.status === "published" || review.status === "pending";
    if (open)
      return (
        <ReviewForm
          initial={{ rating: review.rating, text: review.text }}
          submitLabel="Save changes"
          busyLabel="Saving…"
          save={(input) => updateReview(review.id, input)}
          onSaved={() => done("Your review was updated.")}
          onCancel={() => setOpen(false)}
        />
      );
    return (
      <div className="space-y-3">
        {saved && <FormAlert tone="success">{saved}</FormAlert>}
        <div className="rounded-2xl bg-primary/5 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">Your review</span>
            <Stars rating={review.rating} />
          </div>
          {STATUS_NOTE[review.status] && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{STATUS_NOTE[review.status]}</p>
          )}
        </div>
        <div className="flex gap-3">
          {editable && (
            <Button type="button" variant="outline" onClick={() => setOpen(true)}>
              Edit review
            </Button>
          )}
          <Link
            href="/profile/reviews"
            className="flex h-12 w-full items-center justify-center rounded-full px-5 text-base font-medium text-primary hover:bg-primary/5"
          >
            My Reviews
          </Link>
        </div>
      </div>
    );
  }

  if (open)
    return (
      <ReviewForm
        submitLabel="Post review"
        busyLabel="Posting…"
        save={(input) => createReview(productId, input)}
        onSaved={() => done("Thanks! Your review was posted.")}
        onCancel={() => setOpen(false)}
      />
    );
  return (
    <div className="space-y-3">
      {saved && <FormAlert tone="success">{saved}</FormAlert>}
      <p className="text-sm leading-relaxed text-muted-foreground">You bought and received this product. How was it?</p>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Write a review
      </Button>
    </div>
  );
}
