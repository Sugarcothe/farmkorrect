"use client";

import { LoadError } from "@/components/orders/screen-states";

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <LoadError title="Find a Vet" what="Find a Vet" back="/home" retry={retry} />;
}
