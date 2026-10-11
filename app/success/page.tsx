"use client";

import Link from "next/link";
import { AuthScreen, ScreenHeading } from "@/components/auth/auth-screen";
import { buttonClasses } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icons";
import { useOnboardingStep } from "@/lib/onboarding";
import { setOnboarded } from "@/lib/storage";

const benefits: { icon: IconName; title: string; description: string }[] = [
  {
    icon: "stethoscope",
    title: "Find Vets",
    description: "Instantly call vetted poultry veterinarians in your locality.",
  },
  {
    icon: "store",
    title: "Explore Market",
    description:
      "Purchase feed, vaccines, and equipment at native wholesale prices.",
  },
  {
    icon: "graduation-cap",
    title: "Start Training",
    description: "Gain masterclass insights on flock mortality management.",
  },
  {
    icon: "wallet",
    title: "Track Finances",
    description: "Easily log profits, bird mortality rates, and feed expenses.",
  },
];

export default function Success() {
  // only reachable once the server has confirmed the farm was saved
  const onboarding = useOnboardingStep((s) => !!s.setupComplete, "/farm-setup");
  if (!onboarding) return null;

  return (
    <AuthScreen>
      <div className="mx-auto flex size-16 items-center justify-center rounded-full border-[3px] border-primary text-primary">
        <Icon name="check" className="size-8 stroke-[2.5]" />
      </div>
      <ScreenHeading title="You're All Set!">
        {onboarding.fullName && (
          <span className="block font-semibold text-primary">
            Welcome, {onboarding.fullName}
          </span>
        )}
        <span className="mt-1 block">
          Your farm profile has been created successfully. Here is a summary
          of what you can do right now:
        </span>
      </ScreenHeading>

      <ul className="mt-6 space-y-3">
        {benefits.map((b) => (
          <li
            key={b.title}
            className="flex gap-3.5 rounded-2xl border border-foreground/10 bg-white p-4 shadow-sm"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
              <Icon name={b.icon} className="size-5" />
            </span>
            <span>
              <span className="block font-semibold text-foreground">
                {b.title}
              </span>
              <span className="mt-0.5 block text-[0.8125rem] leading-snug text-muted-foreground">
                {b.description}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-8">
        <Link
          href="/home"
          onClick={() => setOnboarded()}
          className={buttonClasses("solid")}
        >
          Go to Dashboard
        </Link>
      </div>
    </AuthScreen>
  );
}
