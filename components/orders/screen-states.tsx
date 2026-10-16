"use client";

import { useState } from "react";
import Link from "next/link";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { Button, buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";

/** Shown when a Market, Orders or Sales screen couldn't be loaded. The error itself is never displayed. */
export function LoadError({ title, what, back, retry }: { title: string; what: string; back: string; retry: () => void }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={title} back={<BackLink href={back} />} />
      <div role="alert" className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-red-50 text-red-600">
          <Icon name="alert-circle" className="size-8" />
        </div>
        <h2 className="mt-5 text-xl font-semibold tracking-tight">We couldn&apos;t load {what}</h2>
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
        <Link href={back} className={buttonClasses("ghost", "mt-2 max-w-xs")}>
          Go back
        </Link>
      </div>
    </main>
  );
}
