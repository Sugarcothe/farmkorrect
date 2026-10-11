"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AuthScreen,
  FormAlert,
  ScreenHeading,
} from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { saveFarm } from "@/lib/auth/api";
import {
  FARM_TYPE_LABELS,
  FARM_TYPES,
  type FarmType,
} from "@/lib/auth/types";
import {
  FARM_LIMITS,
  parseWholeNumber,
  validateFarmName,
  validateLocation,
  validateWholeNumber,
} from "@/lib/auth/validation";
import { updateOnboarding } from "@/lib/onboarding";
import { useForm } from "@/lib/use-form";

const farmTypeOptions = FARM_TYPES.map((value) => ({
  value,
  label: FARM_TYPE_LABELS[value],
}));

function StepIndicator() {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-semibold text-primary">
      Step 2 of 2
      <span aria-hidden="true" className="flex gap-1">
        <span className="h-1.5 w-5 rounded-full bg-primary" />
        <span className="h-1.5 w-5 rounded-full bg-primary" />
      </span>
    </span>
  );
}

// Access is decided by the server page that renders this (app/farm-setup),
// which requires a verified session; the API checks again on save.
export function FarmSetupForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm(
    {
      farmName: "",
      location: "",
      farmType: "",
      birdCount: "",
      yearsOfExperience: "",
    },
    (v) => ({
      farmName: validateFarmName(v.farmName),
      location: validateLocation(v.location),
      farmType: v.farmType ? undefined : "Choose your farm type.",
      birdCount: validateWholeNumber(v.birdCount, FARM_LIMITS.birdCount),
      yearsOfExperience: validateWholeNumber(v.yearsOfExperience, FARM_LIMITS.yearsOfExperience),
    }),
  );

  const onSubmit = form.handleSubmit(async (v) => {
    setSubmitting(true);
    setFormError(null);
    const res = await saveFarm({
      farmName: v.farmName.trim(),
      location: v.location.trim(),
      farmType: v.farmType as FarmType,
      birdCount: parseWholeNumber(v.birdCount)!,
      yearsOfExperience: parseWholeNumber(v.yearsOfExperience)!,
    });
    if (res.ok) {
      updateOnboarding({ setupComplete: true });
      router.push("/success");
      return;
    }
    setSubmitting(false);
    setFormError(res.error);
    if (res.fieldErrors) form.setServerErrors(res.fieldErrors);
  });

  return (
    <AuthScreen backHref="/auth/verify" topBar={<StepIndicator />}>
      <ScreenHeading title="Set Up Your Farm">
        Tell us about your poultry operation to help us adapt diagnostics and
        feed suggestions.
      </ScreenHeading>

      <form onSubmit={onSubmit} noValidate className="mt-7 space-y-4">
        <TextField
          label="Farm Name"
          placeholder="e.g. Alao Poultry Enterprises"
          autoComplete="organization"
          {...form.field("farmName")}
        />
        <TextField
          label="Farm Location"
          placeholder="e.g. Ibadan, Oyo State"
          autoComplete="address-level2"
          {...form.field("location")}
        />
        <SelectField
          label="Farm Type"
          placeholder="Select your farm type"
          options={farmTypeOptions}
          {...form.field("farmType")}
        />
        <TextField
          label="Number of Birds"
          inputMode="numeric"
          placeholder="e.g. 5,000"
          {...form.field("birdCount")}
        />
        <TextField
          label="Years of Experience"
          inputMode="numeric"
          placeholder="e.g. 6"
          {...form.field("yearsOfExperience")}
        />

        {formError && <FormAlert>{formError}</FormAlert>}

        <Button type="submit" loading={submitting} className="mt-2">
          {submitting ? "Saving…" : "Complete Setup"}
        </Button>
      </form>
    </AuthScreen>
  );
}
