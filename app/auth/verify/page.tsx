"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AuthScreen,
  FormAlert,
  IconBadge,
} from "@/components/auth/auth-screen";
import { OtpInput } from "@/components/auth/otp-input";
import { Button } from "@/components/ui/button";
import { resendOtp, verifyOtp } from "@/lib/auth/api";
import { maskPhone } from "@/lib/auth/validation";
import { updateOnboarding, useOnboardingStep } from "@/lib/onboarding";

const CODE_LENGTH = 6;
const RESEND_SECONDS = 45;

export default function Verify() {
  const router = useRouter();
  const onboarding = useOnboardingStep((s) => !!s.phone, "/auth/sign-up");
  const [digits, setDigits] = useState<string[]>(() =>
    Array(CODE_LENGTH).fill(""),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  if (!onboarding?.phone) return null;
  const phone = onboarding.phone;
  const code = digits.join("");

  function handleDigitsChange(next: string[]) {
    setDigits(next);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
      setError(`Enter all ${CODE_LENGTH} digits of the code.`);
      return;
    }
    setVerifying(true);
    setError(null);
    setNotice(null);
    const res = await verifyOtp({ phone, code });
    if (res.ok) {
      updateOnboarding({ phoneVerified: true });
      router.replace(res.data.next === "home" ? "/home" : "/farm-setup");
      return;
    }
    setVerifying(false);
    setError(res.error);
  }

  async function handleResend() {
    setResending(true);
    setError(null);
    setNotice(null);
    const res = await resendOtp({ phone });
    setResending(false);
    if (res.ok) {
      setDigits(Array(CODE_LENGTH).fill(""));
      setSecondsLeft(RESEND_SECONDS);
      setNotice("A new code is on its way.");
    } else {
      setError(res.error);
    }
  }

  return (
    <AuthScreen centered backHref="/auth/sign-up" topBar="OTP Verification">
      <div className="mt-4">
        <IconBadge icon="shield-check" />
      </div>
      <div className="mt-4 text-center">
        <h1
          id="otp-title"
          className="text-[1.625rem] leading-tight font-bold tracking-tight"
        >
          Verify Your Phone
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
          We sent a 6-digit secure code to{" "}
          <strong className="font-semibold whitespace-nowrap text-foreground">
            {maskPhone(phone)}
          </strong>
          . Enter the code below to complete registration.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="mt-7">
        <OtpInput
          value={digits}
          onChange={handleDigitsChange}
          invalid={!!error}
          disabled={verifying}
          labelledBy="otp-title"
          describedBy={error ? "otp-error" : undefined}
        />

        <div className="mt-6 text-center text-sm text-muted-foreground">
          <p>Didn&apos;t receive the code?</p>
          {secondsLeft > 0 ? (
            <p className="mt-1 font-semibold" aria-live="off">
              Resend in{" "}
              <span className="text-amber-600 tabular-nums">
                00:{String(secondsLeft).padStart(2, "0")}
              </span>
            </p>
          ) : (
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="mt-1 rounded font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              {resending ? "Sending…" : "Resend Code"}
            </button>
          )}
        </div>

        <div className="mt-6 space-y-4">
          {error && (
            <div id="otp-error">
              <FormAlert>{error}</FormAlert>
            </div>
          )}
          {notice && <FormAlert tone="success">{notice}</FormAlert>}
          <Button type="submit" loading={verifying}>
            {verifying ? "Verifying…" : "Verify"}
          </Button>
        </div>
      </form>
    </AuthScreen>
  );
}
