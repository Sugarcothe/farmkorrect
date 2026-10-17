"use client";

import { useState } from "react";
import Link from "next/link";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { Button, buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";

// Shown when an admin page couldn't load its data. Nothing is guessed and
// the error itself is never shown.
export default function AdminError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const [retrying, setRetrying] = useState(false);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Admin" back={<BackLink href="/profile" />} />
      <div role="alert" className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-red-50 text-red-600">
          <Icon name="alert-circle" className="size-8" />
        </div>
        <h2 className="mt-5 text-xl font-semibold tracking-tight">We couldn&apos;t load this page</h2>
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
          Something went wrong on our side or your connection dropped. Nothing was changed.
        </p>
        <Button
          type="button"
          className="mt-8 max-w-xs"
          loading={retrying}
          onClick={() => {
            setRetrying(true);
            retry();
          }}
        >
          {retrying ? "Trying again…" : "Try again"}
        </Button>
        <Link href="/admin" className={buttonClasses("ghost", "mt-2 max-w-xs")}>
          Back to Admin
        </Link>
      </div>
    </main>
  );
}
