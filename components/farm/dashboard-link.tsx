"use client";

import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { clearOnboarding } from "@/lib/onboarding";
import { setOnboarded } from "@/lib/storage";

export function DashboardLink() {
  return (
    <Link
      href="/home"
      onClick={() => {
        setOnboarded();
        clearOnboarding();
      }}
      className={buttonClasses("solid")}
    >
      Go to Dashboard
    </Link>
  );
}
