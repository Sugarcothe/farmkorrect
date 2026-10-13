"use client";

import Link from "next/link";
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
import { login } from "@/lib/auth/api";
import {
  normalizeIdentifier,
  validateIdentifier,
} from "@/lib/auth/validation";
import { updateOnboarding } from "@/lib/onboarding";
import { setOnboarded } from "@/lib/storage";
import { useForm } from "@/lib/use-form";

export default function SignIn() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm({ identifier: "", password: "" }, (v) => ({
    identifier: validateIdentifier(v.identifier),
    password: v.password ? undefined : "Enter your password.",
  }));

  const onSubmit = form.handleSubmit(async (v) => {
    setSubmitting(true);
    setFormError(null);
    const res = await login({
      identifier: normalizeIdentifier(v.identifier),
      password: v.password,
    });
    if (res.ok) {
      setOnboarded();
      const next = res.data;
      if (next.next === "verify") {
        // the account exists but its phone was never confirmed: finish that first
        updateOnboarding({
          fullName: next.fullName,
          phone: next.phone,
          phoneVerified: false,
          setupComplete: false,
        });
        router.push("/auth/verify");
      } else {
        router.replace(next.next === "home" ? "/home" : "/farm-setup");
      }
      return;
    }
    setSubmitting(false);
    setFormError(res.error);
    if (res.fieldErrors) form.setServerErrors(res.fieldErrors);
  });

  return (
    <AuthScreen centered backHref="/onboarding">
      <BrandMark />
      <ScreenHeading title="Welcome Back">
        Enter details below to access your poultry dashboard.
      </ScreenHeading>

      <form onSubmit={onSubmit} noValidate className="mt-7 space-y-4">
        <TextField
          label="Email / Phone Number"
          icon="mail"
          placeholder="e.g. babajide@farmkorrect.com.ng"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          {...form.field("identifier")}
        />
        <div>
          <TextField
            label="Password"
            icon="lock"
            type="password"
            placeholder="Enter your password"
            autoComplete="current-password"
            {...form.field("password")}
          />
          <div className="mt-2 text-right text-[0.8125rem]">
            <TextLink href="/auth/forgot-password">Forgot Password?</TextLink>
          </div>
        </div>

        {formError && <FormAlert>{formError}</FormAlert>}

        <Button type="submit" loading={submitting}>
          {submitting ? "Logging In…" : "Log In"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href="/auth/choose-role"
          onClick={() => setOnboarded()}
          className="rounded font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
        >
          Sign Up
        </Link>
      </p>
    </AuthScreen>
  );
}
