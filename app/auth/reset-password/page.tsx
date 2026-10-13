"use client";

import { useEffect, useState } from "react";
import {
  AuthScreen,
  FormAlert,
  IconBadge,
  ScreenHeading,
  TextLink,
} from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { resetPassword } from "@/lib/auth/api";
import { PASSWORD_HINT, validateNewPassword } from "@/lib/auth/validation";
import { useForm } from "@/lib/use-form";

// Reached from the link in a reset message. The token travels in the URL
// fragment, which browsers never send to servers or in Referer headers; it is
// read once and then removed from the address bar.
function takeTokenFromFragment(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (window.location.hash)
    window.history.replaceState(null, "", window.location.pathname);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export default function ResetPassword() {
  // undefined until read on the client, null if the link is unusable
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment only exists in the browser
    setToken(takeTokenFromFragment());
  }, []);

  const form = useForm({ password: "", confirmPassword: "" }, (v) => ({
    password: validateNewPassword(v.password),
    confirmPassword: !v.confirmPassword
      ? "Re-enter your password."
      : v.confirmPassword !== v.password
        ? "Passwords don't match."
        : undefined,
  }));

  const onSubmit = form.handleSubmit(async (v) => {
    if (!token) return;
    setSubmitting(true);
    setFormError(null);
    const res = await resetPassword({ token, password: v.password });
    setSubmitting(false);
    if (res.ok) {
      setDone(true);
      return;
    }
    setFormError(res.error);
    if (res.fieldErrors) form.setServerErrors(res.fieldErrors);
  });

  return (
    <AuthScreen centered backHref="/auth/sign-in" topBar="Reset Password">
      <div className="mt-4">
        <IconBadge icon="lock" />
      </div>
      <ScreenHeading title="Choose a New Password">
        Pick a password you haven&apos;t used here before. You&apos;ll be
        signed out everywhere and can log in with it straight away.
      </ScreenHeading>

      {done ? (
        <div className="mt-7 space-y-4">
          <FormAlert tone="success">
            Your password has been changed. Log in with your new password.
          </FormAlert>
        </div>
      ) : token === null ? (
        <div className="mt-7">
          <FormAlert>
            This reset link is invalid or has expired. Please request a new
            one.
          </FormAlert>
        </div>
      ) : token ? (
        <form onSubmit={onSubmit} noValidate className="mt-7 space-y-4">
          <TextField
            label="New Password"
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
          {formError && <FormAlert>{formError}</FormAlert>}
          <Button type="submit" loading={submitting}>
            {submitting ? "Saving…" : "Reset Password"}
          </Button>
        </form>
      ) : null}

      <div className="mt-6 text-center text-sm">
        <TextLink href={token === null ? "/auth/forgot-password" : "/auth/sign-in"}>
          {token === null ? "Request a new link" : "Back to Login"}
        </TextLink>
      </div>
    </AuthScreen>
  );
}
