"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { markAllNotificationsRead } from "@/lib/notifications/api";
import { setUnreadCount } from "@/lib/notifications/unread-store";

/** "Mark all as read", then the inbox is re-read from the server. */
export function MarkAllRead() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await markAllNotificationsRead();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setUnreadCount(result.data.unreadCount);
    const n = result.data.updated;
    setNotice(n === 0 ? "Everything was already read." : `Marked ${n} notification${n === 1 ? "" : "s"} as read.`);
    router.refresh();
  }

  return (
    <div className="mb-3 space-y-2">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          aria-busy={busy || undefined}
          className="flex h-9 items-center rounded-full px-3 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          {busy ? "Marking…" : "Mark all as read"}
        </button>
      </div>
      {error && <FormAlert>{error}</FormAlert>}
      {notice && <FormAlert tone="success">{notice}</FormAlert>}
    </div>
  );
}
