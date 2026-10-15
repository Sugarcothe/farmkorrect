"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { backButtonClass, ProfileTopBar } from "@/components/profile/profile-parts";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { confirmAccount, getBanks, resolveAccount } from "@/lib/bank-details/api";
import type { Bank, BankAccountSummary, BankVerification } from "@/lib/bank-details/types";
import {
  maskAccountNumber,
  normalizeAccountNumber,
  validateAccountNumber,
  validateBankCode,
} from "@/lib/bank-details/validation";
import { useForm } from "@/lib/use-form";
import { BankAccountFormSkeleton } from "./bank-account-form-skeleton";

type Values = { bankCode: string; accountNumber: string };
type BankList = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; banks: Bank[] };

const OVERVIEW_PATH = "/profile/bank-details";
const DISCARD_MESSAGE = "Leave without saving this bank account?";
const EXPIRED = "That check expired before it was confirmed. Check the account again to continue.";

/**
 * Two steps, both done by the server with Paystack: "Verify Account"
 * looks up the name registered to the account, then the user confirms it
 * and it's saved. The account name can't be typed — it's always the one
 * Paystack returned. With `current`, the new account replaces that one, which
 * stays in place until the replacement has been saved.
 */
export function BankAccountForm({ current }: { current: BankAccountSummary | null }) {
  const router = useRouter();
  const replacing = current !== null;

  const [bankList, setBankList] = useState<BankList>({ status: "loading" });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [verification, setVerification] = useState<BankVerification | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const form = useForm<Values>({ bankCode: "", accountNumber: "" }, (v) => ({
    bankCode: validateBankCode(v.bankCode),
    accountNumber: validateAccountNumber(normalizeAccountNumber(v.accountNumber)),
  }));

  // the bank list comes from Paystack through our server
  useEffect(() => {
    let cancelled = false;
    getBanks().then((res) => {
      if (cancelled) return;
      setBankList(res.ok ? { status: "ready", banks: res.data.banks } : { status: "error", message: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  // a check can only be confirmed for a few minutes
  useEffect(() => {
    if (!verification || busy === "saving") return;
    const timer = setTimeout(() => {
      setVerification(null);
      setConfirmed(false);
      setFormError(EXPIRED);
    }, Math.max(0, new Date(verification.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [verification, busy]);

  useEffect(() => {
    if (verification) confirmRef.current?.focus();
  }, [verification]);

  const dirty = form.values.accountNumber.trim() !== "" || form.values.bankCode !== "" || verification !== null;

  useEffect(() => {
    if (!dirty || busy === "saving") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  function leave() {
    if (busy === "saving") return;
    if (dirty && !window.confirm(DISCARD_MESSAGE)) return;
    router.push(OVERVIEW_PATH);
  }

  function editDetails() {
    setVerification(null);
    setConfirmed(false);
    setFormError(null);
  }

  const onCheck = form.handleSubmit(async (values) => {
    if (busy || verification) return;
    setBusy("checking");
    setFormError(null);
    const res = await resolveAccount({
      bankCode: values.bankCode,
      accountNumber: normalizeAccountNumber(values.accountNumber),
    });
    setBusy(null);
    if (!res.ok) {
      const { bankCode, accountNumber } = res.fieldErrors ?? {};
      form.setServerErrors({ bankCode, accountNumber });
      // shown on the field instead, when it's about one
      setFormError(bankCode || accountNumber ? null : res.error);
      return;
    }
    setVerification(res.data.verification);
  });

  async function onSave() {
    if (!verification || !confirmed || busy) return;
    setBusy("saving");
    setFormError(null);
    const res = await confirmAccount(
      {
        verificationId: verification.id,
        bankCode: verification.bankCode,
        accountNumber: normalizeAccountNumber(form.values.accountNumber),
      },
      replacing,
    );
    if (!res.ok) {
      setBusy(null);
      // the check itself is no longer usable: start again from the details
      if (res.fieldErrors?.verificationId) {
        setVerification(null);
        setConfirmed(false);
      }
      setFormError(res.error);
      return;
    }
    // stays "Saving…" (and locked) until the overview has loaded
    router.push(`${OVERVIEW_PATH}?saved=${replacing ? "changed" : "added"}`);
    router.refresh();
  }

  // a lookup error is about the bank and number together: changing either clears it
  function lookupField(name: keyof Values) {
    const field = form.field(name);
    return {
      ...field,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        field.onChange(e);
        form.setServerErrors({});
        setFormError(null);
      },
    };
  }

  const locked = verification !== null || busy !== null;
  const bankOptions =
    bankList.status === "ready" ? bankList.banks.map((b) => ({ value: b.code, label: b.name })) : [];

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar
        title={replacing ? "Change Bank Account" : "Add Bank Account"}
        back={
          <button type="button" aria-label="Back" onClick={leave} className={backButtonClass}>
            <Icon name="arrow-left" />
          </button>
        }
      />

      <form onSubmit={onCheck} noValidate className="flex flex-1 flex-col px-5 pb-6">
        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
          {replacing ? (
            <>
              Your current account ({current.bankName} {maskAccountNumber(current.accountNumberLast4)}) stays in place
              until the new one is verified and saved.
            </>
          ) : (
            <>Use a Nigerian bank account in your own or your business&apos;s name. We&apos;ll check it with Paystack.</>
          )}
        </p>

        {bankList.status === "loading" ? (
          <div role="status" aria-label="Loading banks">
            <BankAccountFormSkeleton fieldsOnly />
          </div>
        ) : bankList.status === "error" ? (
          <div role="alert" className="rounded-2xl bg-white px-5 py-6 text-center ring-1 ring-foreground/8">
            <Icon name="alert-circle" className="mx-auto size-7 text-red-600" />
            <p className="mt-2 text-sm font-semibold">We couldn&apos;t load the list of banks</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{bankList.message}</p>
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={() => {
                setBankList({ status: "loading" });
                setLoadAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <SelectField
              label="Bank"
              placeholder="Select your bank"
              options={bankOptions}
              disabled={locked}
              {...lookupField("bankCode")}
            />
            <TextField
              label="Account Number"
              inputMode="numeric"
              autoComplete="off"
              placeholder="10-digit account number"
              maxLength={14}
              readOnly={locked}
              hint={locked ? undefined : "Your 10-digit NUBAN account number."}
              {...lookupField("accountNumber")}
            />
            <TextField
              name="accountName"
              label="Account Name"
              icon="lock"
              readOnly
              tabIndex={verification ? 0 : -1}
              value={verification?.accountName ?? ""}
              placeholder="Filled in after we verify the account"
              hint="Provided by your bank through Paystack. It can't be edited."
            />
          </div>
        )}

        {verification && (
          <div
            ref={confirmRef}
            tabIndex={-1}
            role="group"
            aria-labelledby="confirm-heading"
            className="mt-5 rounded-2xl bg-white p-4 ring-1 ring-primary/25 outline-none"
          >
            <h2 id="confirm-heading" className="flex items-center gap-2 text-sm font-semibold text-primary">
              <Icon name="check-circle" className="size-[18px]" />
              Account found — please confirm
            </h2>
            <p className="mt-2 text-sm leading-relaxed">
              <span className="font-semibold break-words">{verification.accountName}</span>
              <br />
              <span className="text-muted-foreground">
                {verification.bankName} · {maskAccountNumber(verification.accountNumberLast4)}
              </span>
            </p>
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed">
              <input
                type="checkbox"
                name="confirm"
                checked={confirmed}
                disabled={busy !== null}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 size-[18px] shrink-0 accent-[var(--color-primary)]"
              />
              <span>This is my account and the name is correct. I want my payouts to go here.</span>
            </label>
          </div>
        )}

        {formError && (
          <div className="mt-5">
            <FormAlert>{formError}</FormAlert>
          </div>
        )}

        <div className="mt-auto grid grid-cols-2 gap-3 pt-6">
          {verification ? (
            <>
              <Button type="button" variant="outline" onClick={editDetails} disabled={busy !== null}>
                Edit Details
              </Button>
              <Button type="button" onClick={onSave} loading={busy === "saving"} disabled={!confirmed}>
                {busy === "saving" ? "Saving…" : "Confirm & Save"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={leave} disabled={busy !== null}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === "checking"} disabled={bankList.status !== "ready"}>
                {busy === "checking" ? "Verifying…" : "Verify Account"}
              </Button>
            </>
          )}
        </div>
      </form>
    </main>
  );
}
