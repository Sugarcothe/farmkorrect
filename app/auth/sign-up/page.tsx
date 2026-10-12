"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AuthScreen,
  BrandMark,
  FormAlert,
  ScreenHeading,
  TextLink,
} from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { register } from "@/lib/auth/api";
import { ROLE_LABELS } from "@/lib/auth/types";
import {
  normalizePhone,
  PASSWORD_HINT,
  validateEmail,
  validateFullName,
  validateNewPassword,
  validatePhone,
} from "@/lib/auth/validation";
import { updateOnboarding, useOnboardingStep } from "@/lib/onboarding";
import { useForm } from "@/lib/use-form";

const initial = {
  fullName: "",
  email: "",
  phone: "",
  password: "",
  confirmPassword: "",
  acceptedTerms: false as boolean,
};

export default function SignUp() {
  const router = useRouter();
  const onboarding = useOnboardingStep((s) => !!s.role, "/auth/choose-role");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm(initial, (v) => ({
    fullName: validateFullName(v.fullName),
    email: validateEmail(v.email),
    phone: validatePhone(v.phone),
    password: validateNewPassword(v.password),
    confirmPassword: !v.confirmPassword
      ? "Re-enter your password."
      : v.confirmPassword !== v.password
        ? "Passwords don't match."
        : undefined,
    acceptedTerms: v.acceptedTerms
      ? undefined
      : "Please accept the Terms of Service and Privacy Policy.",
  }));

  if (!onboarding?.role) return null;
  const role = onboarding.role;

  const onSubmit = form.handleSubmit(async (v) => {
    setSubmitting(true);
    setFormError(null);
    const phone = normalizePhone(v.phone)!;
    const fullName = v.fullName.trim();
    const res = await register({
      role,
      fullName,
      email: v.email.trim().toLowerCase(),
      phone,
      password: v.password,
    });
    if (res.ok) {
      updateOnboarding({
        fullName,
        phone,
        phoneVerified: false,
        setupComplete: false,
      });
      router.push("/auth/verify");
      return;
    }
    setSubmitting(false);
    setFormError(res.error);
    if (res.fieldErrors) form.setServerErrors(res.fieldErrors);
  });

  return (
    <AuthScreen backHref="/auth/choose-role">
      <BrandMark />
      <ScreenHeading title="Create Account">
        Join the largest vetted poultry network in Nigeria.
      </ScreenHeading>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Signing up as{" "}
        <span className="font-semibold text-foreground">
          {ROLE_LABELS[role]}
        </span>{" "}
        · <TextLink href="/auth/choose-role">Change</TextLink>
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <TextField
          label="Full Name"
          icon="user"
          placeholder="e.g. Babajide Alao"
          autoComplete="name"
          {...form.field("fullName")}
        />
        <TextField
          label="Email Address"
          icon="mail"
          type="email"
          inputMode="email"
          placeholder="e.g. babajide@farmkorrect.com.ng"
          autoComplete="email"
          {...form.field("email")}
        />
        <TextField
          label="Phone Number"
          icon="phone"
          type="tel"
          inputMode="tel"
          placeholder="0812 345 6789"
          autoComplete="tel-national"
          {...form.field("phone")}
        />
        <TextField
          label="Password"
          icon="lock"
          type="password"
          placeholder="Enter secure password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          {...form.field("password")}
        />
        <TextField
          label="Confirm Password"
          icon="lock"
          type="password"
          placeholder="Repeat your password"
          autoComplete="new-password"
          {...form.field("confirmPassword")}
        />

        <div>
          <label className="flex cursor-pointer items-start gap-2.5 text-[0.8125rem] leading-snug text-muted-foreground">
            <input
              type="checkbox"
              name="acceptedTerms"
              checked={form.values.acceptedTerms}
              onChange={(e) => form.setValue("acceptedTerms", e.target.checked)}
              aria-invalid={form.errors.acceptedTerms ? true : undefined}
              aria-describedby="terms-error"
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            />
            <span>
              I agree to the{" "}
              <strong className="text-foreground">Terms of Service</strong> and{" "}
              <strong className="text-foreground">Privacy Policy</strong> of
              Farm Korect.
            </span>
          </label>
          {form.errors.acceptedTerms && (
            <p
              id="terms-error"
              className="mt-1.5 text-xs font-medium text-red-600"
            >
              {form.errors.acceptedTerms}
            </p>
          )}
        </div>

        {formError && <FormAlert>{formError}</FormAlert>}

        <Button type="submit" loading={submitting} className="mt-2">
          {submitting ? "Creating Account…" : "Create Account"}
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-muted-foreground">
        Already have an account? <TextLink href="/auth/sign-in">Log In</TextLink>
      </p>
    </AuthScreen>
  );
}
