"use client";

import { useState } from "react";
import {
  AuthScreen,
  FormAlert,
  IconBadge,
  ScreenHeading,
  TextLink,
} from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { requestPasswordReset } from "@/lib/auth/api";
import {
  normalizeIdentifier,
  validateIdentifier,
} from "@/lib/auth/validation";
import { useForm } from "@/lib/use-form";

export default function ForgotPassword() {
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const form = useForm({ identifier: "" }, (v) => ({
    identifier: validateIdentifier(v.identifier),
  }));

  const onSubmit = form.handleSubmit(async (v) => {
    setSubmitting(true);
    setFormError(null);
    const identifier = normalizeIdentifier(v.identifier);
    const res = await requestPasswordReset({ identifier });
    setSubmitting(false);
    if (res.ok) setSentTo(identifier);
    else setFormError(res.error);
  });

  return (
    <AuthScreen centered backHref="/auth/sign-in" topBar="Reset Password">
      <div className="mt-4">
        <IconBadge icon="lock" />
      </div>
      <ScreenHeading title="Forgot Password?">
        No worries. Enter your registered email address or phone number and
        we&apos;ll send you instructions to safely reset your account.
      </ScreenHeading>

      {sentTo ? (
        <div className="mt-7">
          <FormAlert tone="success">
            If an account matches{" "}
            <strong className="font-semibold">{sentTo}</strong>, reset
            instructions are on their way. Check your email or messages.
          </FormAlert>
        </div>
      ) : (
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
          {formError && <FormAlert>{formError}</FormAlert>}
          <Button type="submit" loading={submitting}>
            {submitting ? "Sending…" : "Send Reset Link"}
          </Button>
        </form>
      )}

      <div className="mt-6 text-center text-sm">
        <TextLink href="/auth/sign-in">
          <span className="inline-flex items-center gap-1.5">
            <Icon name="arrow-left" className="size-4" />
            Back to Login
          </span>
        </TextLink>
      </div>
    </AuthScreen>
  );
}
