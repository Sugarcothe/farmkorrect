"use client";

import { LoadError } from "@/components/orders/screen-states";

export default function Error({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <LoadError title="My Reviews" what="your reviews" back="/profile" retry={retry} />;
}
