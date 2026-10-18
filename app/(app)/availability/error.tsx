"use client";

import { LoadError } from "@/components/orders/screen-states";

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <LoadError title="Availability" what="your availability" back="/home" retry={retry} />;
}
