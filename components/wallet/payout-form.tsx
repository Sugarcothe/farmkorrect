"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { maskAccountNumber } from "@/lib/bank-details/validation";
import { requestPayout } from "@/lib/wallet/api";
import { formatKobo, koboToInput, parseNairaToKobo } from "@/lib/wallet/money";
import { MIN_PAYOUT_KOBO, type PayoutDestination } from "@/lib/wallet/types";

// Amount → confirm → submit. One idempotency key is made per visit to this
// form, so a double tap or a retry after a dropped connection returns the
// same payout instead of creating another. Success is only shown once the
// server has saved the request.

export function PayoutForm({ availableKobo, destination }: { availableKobo: number; destination: PayoutDestination }) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const [needsAccount, setNeedsAccount] = useState(false);

  function review(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    const kobo = parseNairaToKobo(amount);
    if (kobo === null || kobo === 0) return setFieldError("Enter an amount in naira, like 5000.");
    if (kobo < MIN_PAYOUT_KOBO) return setFieldError(`The smallest payout is ${formatKobo(MIN_PAYOUT_KOBO)}.`);
    if (kobo > availableKobo) return setFieldError(`You can withdraw up to ${formatKobo(availableKobo)}.`);
    setFieldError(undefined);
    setConfirming(kobo);
  }

  async function submit() {
    if (confirming === null || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const result = await requestPayout({ amountKobo: confirming, idempotencyKey });
    if (result.ok) {
      router.replace("/wallet?payout=requested");
      router.refresh();
      return;
    }
    setSubmitting(false);
    if (result.fieldErrors?.bankAccount) {
      setNeedsAccount(true);
      setError(result.fieldErrors.bankAccount);
    } else if (result.fieldErrors?.amountKobo) {
      setConfirming(null);
      setFieldError(result.fieldErrors.amountKobo);
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="flex flex-1 flex-col px-5 pb-8">
      <div className="rounded-2xl bg-primary/6 px-4 py-3.5">
        <p className="text-xs text-muted-foreground">Available to withdraw</p>
        <p className="mt-0.5 text-xl font-semibold tabular-nums text-primary">{formatKobo(availableKobo)}</p>
      </div>

      <div className="mt-4 flex items-center gap-3 rounded-2xl bg-white px-4 py-3.5 shadow-sm ring-1 ring-foreground/5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
          <Icon name="landmark" className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Paid into</p>
          <p className="truncate text-[0.9375rem] font-medium">
            {destination.bankName}{" "}
            <span className="font-mono text-sm tracking-wider text-muted-foreground">
              <span className="sr-only">ending in {destination.accountNumberLast4}</span>
              <span aria-hidden="true">{maskAccountNumber(destination.accountNumberLast4)}</span>
            </span>
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <FormAlert>
            {error}
            {needsAccount && (
              <>
                {" "}
                <Link href="/profile/bank-details" className="font-semibold underline">
                  Go to Bank Details
                </Link>
              </>
            )}
          </FormAlert>
        </div>
      )}

      {confirming === null ? (
        <form onSubmit={review} noValidate className="mt-5 flex flex-1 flex-col">
          <TextField
            name="amount"
            label="Amount (₦)"
            inputMode="decimal"
            autoComplete="off"
            placeholder="e.g. 5000"
            value={amount}
            error={fieldError}
            hint={`Minimum ${formatKobo(MIN_PAYOUT_KOBO)}`}
            onChange={(e) => {
              setAmount(e.target.value);
              setFieldError(undefined);
            }}
          />
          <button
            type="button"
            onClick={() => {
              setAmount(koboToInput(availableKobo));
              setFieldError(undefined);
            }}
            className="mt-2 self-start rounded-full px-1 text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          >
            Withdraw all ({formatKobo(availableKobo)})
          </button>
          <div className="mt-auto pt-8">
            <Button type="submit">Continue</Button>
          </div>
        </form>
      ) : (
        <section aria-labelledby="confirm-heading" className="mt-5 flex flex-1 flex-col">
          <h2 id="confirm-heading" className="text-lg font-semibold tracking-tight">
            Confirm payout
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">{formatKobo(confirming)}</span> will be sent to your{" "}
            {destination.bankName} account ending in {destination.accountNumberLast4}. It&apos;s set aside from your
            balance straight away and shows as paid once your bank confirms it.
          </p>
          <div className="mt-auto space-y-2 pt-8">
            <Button type="button" loading={submitting} onClick={submit}>
              {submitting ? "Requesting…" : `Withdraw ${formatKobo(confirming)}`}
            </Button>
            <Button type="button" variant="ghost" disabled={submitting} onClick={() => setConfirming(null)}>
              Change amount
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
