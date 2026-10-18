"use client";

import { LoadError } from "@/components/orders/screen-states";

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <LoadError title="Jobs" what="your jobs" back="/home" retry={retry} />;
}
