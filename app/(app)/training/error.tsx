"use client";

import { LoadError } from "@/components/orders/screen-states";

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <LoadError title="Korret Academy" what="Korret Academy" back="/home" retry={retry} />;
}
