"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { FARM_TYPE_LABELS, FARM_TYPES, ROLE_LABELS } from "@/lib/auth/types";
import {
  FARM_LIMITS,
  FIELD_MAX_LENGTH,
  parseWholeNumber,
  validateFarmName,
  validateFullName,
  validateLocation,
  validateWholeNumber,
} from "@/lib/auth/validation";
import { updateProfile, uploadProfilePhoto } from "@/lib/profile/api";
import { PHOTO_RULES, PROFILE_CONFIG, SPECIALIZATIONS } from "@/lib/profile/config";
import type { Profile, ProfileField, ProfileUpdateRequest } from "@/lib/profile/types";
import {
  cleanText,
  PROFILE_MAX_LENGTH,
  validateBio,
  validatePracticeLocation,
  validateQualifications,
  validateRegistrationNumber,
  validateSpecialization,
} from "@/lib/profile/validation";
import { useForm } from "@/lib/use-form";
import { backButtonClass, ProfileAvatar, ProfileTopBar } from "./profile-parts";

type Values = Record<ProfileField, string>;

const farmTypeOptions = FARM_TYPES.map((value) => ({ value, label: FARM_TYPE_LABELS[value] }));

const NUMBER_FIELDS: readonly ProfileField[] = ["yearsOfExperience", "birdCount"];
const MULTILINE_FIELDS: readonly ProfileField[] = ["bio"];

function initialValues(profile: Profile): Values {
  return {
    fullName: profile.fullName,
    bio: profile.bio,
    location: profile.location,
    yearsOfExperience: profile.yearsOfExperience === null ? "" : String(profile.yearsOfExperience),
    farmName: profile.farm?.farmName ?? "",
    farmType: profile.farm?.farmType ?? "",
    birdCount: profile.farm ? String(profile.farm.birdCount) : "",
    specialization: profile.specialization,
    qualifications: profile.qualifications,
    registrationNumber: profile.registrationNumber,
  };
}

/** The normalised value the server would store for a field. */
function normalise(field: ProfileField, value: string): string | number | null {
  if (NUMBER_FIELDS.includes(field)) return parseWholeNumber(value);
  if (field === "registrationNumber") return cleanText(value).toUpperCase();
  if (field === "specialization" || field === "farmType") return value;
  return cleanText(value, MULTILINE_FIELDS.includes(field));
}

const DISCARD_MESSAGE = "Discard your unsaved changes?";

/**
 * Edits the signed-in user's own profile. Which fields appear comes from the
 * role on the server-rendered profile; the API enforces the same rules.
 */
export function EditProfileForm({ profile }: { profile: Profile }) {
  const router = useRouter();
  const { role } = profile;
  const config = PROFILE_CONFIG[role];
  const editable = new Set<ProfileField>(config.editableFields);
  const isFarmer = role === "poultry-farmer";

  const [initial, setInitial] = useState(() => initialValues(profile));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedPhotoUrl, setSavedPhotoUrl] = useState(profile.photoUrl);
  // the chosen file and its blob: preview URL, which must be released
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const form = useForm<Values>(initial, (v) => {
    const errors: Partial<Record<ProfileField, string>> = {
      fullName:
        validateFullName(v.fullName) ??
        (v.fullName.trim().length > FIELD_MAX_LENGTH.fullName ? "Enter a shorter name." : undefined),
      bio: validateBio(v.bio),
      location: isFarmer ? validateLocation(v.location) : validatePracticeLocation(v.location),
      yearsOfExperience: validateWholeNumber(v.yearsOfExperience, FARM_LIMITS.yearsOfExperience),
    };
    if (isFarmer) {
      errors.farmName = validateFarmName(v.farmName);
      errors.farmType = v.farmType ? undefined : "Choose your farm type.";
      errors.birdCount = validateWholeNumber(v.birdCount, FARM_LIMITS.birdCount);
    } else {
      errors.specialization = validateSpecialization(role, v.specialization);
      errors.qualifications = validateQualifications(v.qualifications);
    }
    if (editable.has("registrationNumber"))
      errors.registrationNumber = validateRegistrationNumber(v.registrationNumber);
    return errors;
  });

  /** Only fields this role may edit, and only those that actually changed. */
  function changes(values: Values): ProfileUpdateRequest {
    const update: Record<string, string | number> = {};
    for (const field of config.editableFields) {
      const next = normalise(field, values[field]);
      if (next === null || next === normalise(field, initial[field])) continue;
      update[field] = next;
    }
    return update as ProfileUpdateRequest;
  }

  const pendingChanges = changes(form.values);
  const dirty = photo !== null || Object.keys(pendingChanges).length > 0;

  // warn before a reload, tab close or typed URL throws away edits (in-app
  // navigation goes through leave(), which asks first)
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // release each preview once it's replaced, saved or the page closes
  useEffect(() => {
    if (!photo) return;
    return () => URL.revokeObjectURL(photo.url);
  }, [photo]);

  function leave() {
    if (submitting) return;
    if (dirty && !window.confirm(DISCARD_MESSAGE)) return;
    router.push("/profile");
  }

  function choosePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be picked again after an error
    if (!file) return;
    setFormError(null);
    if (!(PHOTO_RULES.types as readonly string[]).includes(file.type)) {
      setPhotoError("Choose a JPG, PNG or WebP photo.");
      return;
    }
    if (file.size > PHOTO_RULES.maxBytes) {
      setPhotoError(`That photo is too large. Choose one under ${PHOTO_RULES.maxBytes / (1024 * 1024)} MB.`);
      return;
    }
    setPhotoError(null);
    setPhoto({ file, url: URL.createObjectURL(file) });
  }

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitting || !dirty) return;
    setSubmitting(true);
    setFormError(null);

    let photoSaved = false;
    if (photo) {
      const res = await uploadProfilePhoto(photo.file);
      if (!res.ok) {
        setSubmitting(false);
        setPhotoError(res.error);
        setFormError(`Nothing was saved. ${res.error}`);
        return;
      }
      photoSaved = true;
      setSavedPhotoUrl(res.data.photoUrl);
      setPhoto(null);
    }

    const update = changes(values);
    if (Object.keys(update).length > 0) {
      const res = await updateProfile(update);
      if (!res.ok) {
        setSubmitting(false);
        setFormError(
          photoSaved ? `Your new photo was saved, but your other changes weren't. ${res.error}` : res.error,
        );
        if (res.fieldErrors) form.setServerErrors(res.fieldErrors);
        return;
      }
      // the saved values are the new baseline if the user stays on the page
      setInitial(initialValues(res.data.profile));
    }

    router.push("/profile?updated=1");
    router.refresh();
  });

  const shownPhoto = photo?.url ?? savedPhotoUrl;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar
        title="Edit Profile"
        back={
          <button type="button" aria-label="Back" onClick={leave} className={backButtonClass}>
            <Icon name="arrow-left" />
          </button>
        }
      />

      <form onSubmit={onSubmit} noValidate className="flex flex-1 flex-col px-5 pb-6">
        <div className="flex flex-col items-center">
          <div className="relative">
            <ProfileAvatar photoUrl={shownPhoto} name={form.values.fullName || profile.fullName} />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={submitting}
              aria-label={shownPhoto ? "Change profile photo" : "Add profile photo"}
              className="absolute right-0 bottom-0 flex size-9 items-center justify-center rounded-full bg-primary text-white shadow-md ring-3 ring-surface outline-none hover:bg-primary-dark focus-visible:ring-accent disabled:opacity-60"
            >
              <Icon name="camera" className="size-[18px]" />
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={PHOTO_RULES.types.join(",")}
            onChange={choosePhoto}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          <p className={`mt-2 text-xs ${photoError ? "font-medium text-red-600" : "text-muted-foreground"}`} role={photoError ? "alert" : undefined}>
            {photoError ?? (photo ? "New photo selected — save to keep it." : "JPG, PNG or WebP, up to 5 MB.")}
          </p>
        </div>

        <div className="mt-5 space-y-4">
          <TextField label="Full Name" icon="user" autoComplete="name" maxLength={FIELD_MAX_LENGTH.fullName} {...form.field("fullName")} />
          <TextField
            label="Email Address"
            icon="mail"
            value={profile.email}
            name="email-readonly"
            readOnly
            aria-readonly="true"
            className="[&_input]:text-foreground/55"
            hint="Changing your email needs re-verification, which isn't available yet."
          />
          <TextField
            label="Phone Number"
            icon="phone"
            value={profile.phone}
            name="phone-readonly"
            readOnly
            aria-readonly="true"
            className="[&_input]:text-foreground/55"
            hint="Your verified phone number can't be changed here yet."
          />

          {isFarmer ? (
            <>
              <TextField label="Farm Name" placeholder="e.g. Alao Poultry Enterprises" autoComplete="organization" {...form.field("farmName")} />
              <TextField label="Farm Location" icon="map-pin" placeholder="e.g. Ibadan, Oyo State" autoComplete="address-level2" {...form.field("location")} />
              <SelectField label="Farm Type" placeholder="Select your farm type" options={farmTypeOptions} {...form.field("farmType")} />
              <TextField label="Number of Birds" inputMode="numeric" placeholder="e.g. 5,000" {...form.field("birdCount")} />
              <TextField label="Years of Experience" inputMode="numeric" placeholder="e.g. 6" {...form.field("yearsOfExperience")} />
            </>
          ) : (
            <>
              <SelectField
                label={role === "veterinarian" ? "Specialization" : "Service Category"}
                placeholder="Select one"
                options={SPECIALIZATIONS[role]}
                {...form.field("specialization")}
              />
              <TextField label="Years of Experience" inputMode="numeric" placeholder="e.g. 6" {...form.field("yearsOfExperience")} />
              <TextField label="Location" icon="map-pin" placeholder="e.g. Ibadan, Oyo State" autoComplete="address-level2" {...form.field("location")} />
              <TextField
                label="Qualifications"
                placeholder={role === "veterinarian" ? "e.g. DVM, University of Ibadan" : "e.g. B.Agric, Animal Science"}
                maxLength={PROFILE_MAX_LENGTH.qualifications}
                hint="Optional"
                {...form.field("qualifications")}
              />
            </>
          )}

          {editable.has("registrationNumber") && (
            <TextField
              label="VCN Registration Number"
              placeholder="e.g. VCN/12345"
              autoCapitalize="characters"
              maxLength={PROFILE_MAX_LENGTH.registrationNumber}
              readOnly={profile.credentialStatus === "verified"}
              hint={
                profile.credentialStatus === "verified"
                  ? "Verified. Contact support to change it."
                  : "Optional. A new number is reviewed by our team before it shows as verified."
              }
              {...form.field("registrationNumber")}
            />
          )}

          <TextAreaField
            label="Bio"
            placeholder={`Tell farmers about yourself as a ${ROLE_LABELS[role].toLowerCase()}.`}
            maxLength={PROFILE_MAX_LENGTH.bio}
            hint={`${cleanText(form.values.bio, true).length}/${PROFILE_MAX_LENGTH.bio} characters`}
            {...form.field("bio")}
          />
        </div>

        {formError && (
          <div className="mt-5">
            <FormAlert>{formError}</FormAlert>
          </div>
        )}

        <div className="mt-auto grid grid-cols-2 gap-3 pt-6">
          <Button type="button" variant="outline" onClick={leave} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={!dirty}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </main>
  );
}

