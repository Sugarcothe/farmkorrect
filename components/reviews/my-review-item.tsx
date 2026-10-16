"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { formatDate } from "@/components/wallet/wallet-parts";
import { updateReview, withdrawReview } from "@/lib/reviews/api";
import type { MyReview } from "@/lib/reviews/types";
import { ReviewForm } from "./review-form";
import { ReviewStatusBadge, STATUS_NOTE } from "./review-status";
import { Stars, VerifiedBadge } from "./stars";

type Mode = "view" | "edit" | "confirm-withdraw";

/**
 * One of the user's reviews on My Reviews, with Edit and Withdraw. Withdraw
 * asks for confirmation first. After a change the list is re-read from the
 * server, so what's shown is what was stored.
 */
export function MyReviewItem({ review }: { review: MyReview }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changeable = review.status === "published" || review.status === "pending";

  async function withdraw() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await withdrawReview(review.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMode("view");
    setNotice("Your review was withdrawn. It's no longer shown on the product.");
    router.refresh();
  }

  return (
    <li className="px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {review.productListed ? (
            <Link
              href={`/market/${review.productId}#reviews`}
              className="text-sm font-semibold text-primary underline-offset-2 hover:underline"
            >
              {review.productName}
            </Link>
          ) : (
            <span className="text-sm font-semibold">{review.productName}</span>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">
            <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
            {review.editedAt && " · edited"}
            {!review.productListed && " · no longer listed"}
          </p>
        </div>
        <ReviewStatusBadge status={review.status} />
      </div>

      {notice && (
        <div className="mt-3">
          <FormAlert tone="success">{notice}</FormAlert>
        </div>
      )}

      {mode === "edit" ? (
        <div className="mt-4">
          <ReviewForm
            initial={{ rating: review.rating, text: review.text }}
            submitLabel="Save changes"
            busyLabel="Saving…"
            save={(input) => updateReview(review.id, input)}
            onSaved={() => {
              setMode("view");
              setNotice("Your review was updated.");
              router.refresh();
            }}
            onCancel={() => setMode("view")}
          />
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Stars rating={review.rating} />
            {review.verifiedPurchase && <VerifiedBadge />}
          </div>
          <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-foreground/80">{review.text}</p>
          {STATUS_NOTE[review.status] && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{STATUS_NOTE[review.status]}</p>
          )}
        </>
      )}

      {mode === "confirm-withdraw" && (
        <div role="alertdialog" aria-labelledby={`withdraw-${review.id}`} className="mt-3 rounded-2xl bg-red-50 px-4 py-3">
          <p id={`withdraw-${review.id}`} className="text-sm leading-relaxed text-red-900">
            Withdraw this review? It will be removed from the product and its rating. You can write a new one later.
          </p>
          {error && (
            <div className="mt-3">
              <FormAlert>{error}</FormAlert>
            </div>
          )}
          <div className="mt-3 flex gap-3">
            <Button type="button" variant="outline" onClick={() => setMode("view")} disabled={busy}>
              Keep it
            </Button>
            <Button type="button" loading={busy} onClick={withdraw} className="bg-red-600 hover:bg-red-700">
              {busy ? "Withdrawing…" : "Withdraw"}
            </Button>
          </div>
        </div>
      )}

      {mode === "view" && changeable && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setMode("edit");
            }}
            className="flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="pencil" className="size-4" />
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setError(null);
              setMode("confirm-withdraw");
            }}
            className="flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="trash" className="size-4" />
            Withdraw
          </button>
        </div>
      )}
    </li>
  );
}
