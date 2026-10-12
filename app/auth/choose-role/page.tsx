"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icons";
import { ROLE_LABELS, type Role } from "@/lib/auth/types";
import { updateOnboarding, useOnboarding } from "@/lib/onboarding";

const roles: { value: Role; icon: IconName; description: string }[] = [
  {
    value: "poultry-farmer",
    icon: "egg",
    description:
      "Manage your farm inventory, access real-time diagnostic tools, live referrals, and source directly from trusted markets.",
  },
  {
    value: "veterinarian",
    icon: "stethoscope",
    description:
      "Offer specialized clinical services, consult on flock health, manage bookings, and expand your expert network across Nigeria.",
  },
  {
    value: "non-vet-specialist",
    icon: "briefcase",
    description:
      "For animal scientists, farm technicians, nutrition experts, and professional poultry handlers offering specialized technical services.",
  },
];

export default function ChooseRole() {
  const router = useRouter();
  const onboarding = useOnboarding();
  const [picked, setPicked] = useState<Role | null>(null);
  const selected = picked ?? onboarding?.role ?? "poultry-farmer";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateOnboarding({ role: selected });
    router.push("/auth/sign-up");
  }

  return (
    <AuthScreen backHref="/onboarding">
      <h1 className="text-[1.625rem] leading-tight font-bold tracking-tight">
        Choose Your Role
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Select how you want to interact with the Farm Korect poultry
        ecosystem. This customizes your dashboard.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-1 flex-col">
        <fieldset className="space-y-3">
          <legend className="sr-only">Your role</legend>
          {roles.map((role) => {
            const isSelected = role.value === selected;
            return (
              <label
                key={role.value}
                className={`relative flex cursor-pointer gap-3.5 rounded-2xl border bg-white p-4 shadow-sm transition-colors has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-accent has-[input:focus-visible]:ring-offset-2 ${
                  isSelected
                    ? "border-accent bg-accent/[0.06]"
                    : "border-foreground/10 hover:border-accent/40"
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value={role.value}
                  checked={isSelected}
                  onChange={() => setPicked(role.value)}
                  className="sr-only"
                />
                <span
                  className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${
                    isSelected
                      ? "bg-primary text-white"
                      : "bg-primary/8 text-primary"
                  }`}
                >
                  <Icon name={role.icon} className="size-[22px]" />
                </span>
                <span className="min-w-0 flex-1 pr-6">
                  <span className="block font-semibold text-foreground">
                    {ROLE_LABELS[role.value]}
                  </span>
                  <span className="mt-1 block text-[0.8125rem] leading-snug text-muted-foreground">
                    {role.description}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`absolute top-4 right-4 flex size-5 items-center justify-center rounded-full transition-colors ${
                    isSelected
                      ? "bg-primary text-white"
                      : "border border-foreground/20"
                  }`}
                >
                  {isSelected && (
                    <Icon name="check" className="size-3.5 stroke-3" />
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="mt-auto pt-8">
          <Button type="submit">Continue</Button>
        </div>
      </form>
    </AuthScreen>
  );
}
