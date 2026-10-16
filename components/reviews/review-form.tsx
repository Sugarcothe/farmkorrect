"use client";

import { useId, useState } from "react";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import type { ApiResult } from "@/lib/auth/types";
import { RATING_WORDS, REVIEW_LIMITS, type ReviewInput, type ReviewResponse } from "@/lib/reviews/types";
import { cleanReviewText, validateRating, validateReviewText } from "@/lib/reviews/validation";
import { useForm } from "@/lib/use-form";

type Values = { rating: string; text: string };

/**
 * Five radio buttons drawn as stars, so arrow keys, Tab and screen readers
 * work as they do for any radio group.
 */
function StarRatingInput({
  value,
  onChange,
  error,
  disabled,
}: {
  value: number;
  onChange: (rating: number) => void;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <fieldset aria-describedby={error ? `${id}-message` : undefined} disabled={disabled}>
      <legend className="mb-1.5 block text-[0.8125rem] font-semibold text-foreground">Your rating</legend>
      <div className="flex flex-wrap items-center gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label
            key={n}
            onMouseEnter={() => setHover(n)}
            className="cursor-pointer rounded-lg p-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent"
          >
            <input
              type="radio"
              name="rating"
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              className="sr-only"
            />
            <Icon
              name="star"
              className={`size-8 transition-colors ${n <= shown ? "fill-amber-400 text-amber-400" : "text-foreground/25"}`}
            />
            <span className="sr-only">
              {n} star{n === 1 ? "" : "s"}, {RATING_WORDS[n - 1]}
            </span>
          </label>
        ))}
        <span aria-hidden="true" className="ml-1 text-sm font-medium text-muted-foreground">
          {shown ? RATING_WORDS[shown - 1] : ""}
        </span>
      </div>
      {error && (
        <p id={`${id}-message`} className="mt-1.5 text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The review form, for a new review or an edit. Values are checked here and
 * again by the server; on any failure the form keeps what was typed and
 * shows the server's message. Success is only reported once the server
 * has saved the review.
 */
export function ReviewForm({
  initial,
  submitLabel,
  busyLabel,
  save,
  onSaved,
  onCancel,
}: {
  initial?: ReviewInput;
  submitLabel: string;
  busyLabel: string;
  save: (input: ReviewInput) => Promise<ApiResult<ReviewResponse>>;
  onSaved: (result: ReviewResponse) => void;
  onCancel: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<Values>({ rating: String(initial?.rating ?? 0), text: initial?.text ?? "" }, (v) => ({
    rating: validateRating(Number(v.rating)),
    text: validateReviewText(v.text),
  }));
  const length = cleanReviewText(form.values.text).length;
  const { max } = REVIEW_LIMITS.text;

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    const result = await save({ rating: Number(values.rating), text: cleanReviewText(values.text) });
    setSubmitting(false);
    if (!result.ok) {
      setFormError(result.error);
      if (result.fieldErrors) form.setServerErrors(result.fieldErrors);
      return;
    }
    onSaved(result.data);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <StarRatingInput
        value={Number(form.values.rating)}
        onChange={(n) => form.setValue("rating", String(n))}
        error={form.errors.rating}
        disabled={submitting}
      />
      <div>
        <TextAreaField
          label="Your review"
          placeholder="How was the product? Was it as described, fresh, well packed?"
          maxLength={max + 50}
          rows={4}
          disabled={submitting}
          {...form.field("text")}
        />
        <p className={`mt-1 text-right text-xs tabular-nums ${length > max ? "font-medium text-red-600" : "text-muted-foreground"}`}>
          {length} / {max}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Your first name and last initial are shown with your review. Your order details are not.
      </p>
      {formError && <FormAlert>{formError}</FormAlert>}
      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          {submitting ? busyLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
