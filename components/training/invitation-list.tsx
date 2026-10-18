"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { respondToInvitation } from "@/lib/training/api";
import { staffRoleSingle, type InvitationDecision, type StaffInvitation } from "@/lib/training/types";

/**
 * Staff invitations sent to this user's verified phone number. Accepting
 * shares their training progress on the farm's programme with its owner;
 * nothing changes on screen until the server confirms.
 */
export function InvitationList({ invitations }: { invitations: StaffInvitation[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<{ id: string; decision: InvitationDecision } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function respond(invitation: StaffInvitation, decision: InvitationDecision) {
    setBusy({ id: invitation.id, decision });
    setError(null);
    setNotice(null);
    const result = await respondToInvitation(invitation.id, decision);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      router.refresh();
      return;
    }
    setNotice(
      result.data.status === "active"
        ? `You joined ${invitation.farmName}'s staff training.`
        : `You declined ${invitation.farmName}'s invitation.`,
    );
    router.refresh();
  }

  if (invitations.length === 0 && !notice && !error) return null;
  return (
    <section aria-labelledby="invitations-heading" className="mb-6">
      <h2 id="invitations-heading" className="sr-only">
        Staff invitations
      </h2>
      <div className="space-y-3" aria-live="polite">
        {notice && <FormAlert tone="success">{notice}</FormAlert>}
        {error && <FormAlert>{error}</FormAlert>}
        {invitations.map((inv) => (
          <article key={inv.id} className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-accent/30">
            <div className="flex gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-primary">
                <Icon name="users" className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{inv.farmName} invited you to staff training</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  As a {staffRoleSingle(inv.role).toLowerCase()}. If you accept, the farm owner can see your progress in
                  the courses they assign. You can still take any course on your own.
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-10 text-sm"
                disabled={busy !== null}
                loading={busy?.id === inv.id && busy.decision === "decline"}
                onClick={() => respond(inv, "decline")}
              >
                Decline
              </Button>
              <Button
                type="button"
                className="h-10 text-sm"
                disabled={busy !== null}
                loading={busy?.id === inv.id && busy.decision === "accept"}
                onClick={() => respond(inv, "accept")}
              >
                Accept
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
