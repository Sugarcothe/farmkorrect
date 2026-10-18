"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button, buttonClasses } from "@/components/ui/button";
import { changePromotionStatus } from "@/lib/promotions/api";
import type { Promotion, PromotionAction } from "@/lib/promotions/types";

const CONFIRM: Record<PromotionAction, string> = {
  activate: "Activate this promotion? Buyers will get the discount from its start time.",
  pause: "Pause this promotion? Buyers stop getting the discount; orders already placed keep their price.",
  end: "End this promotion for good? It can't be restarted; orders already placed keep their price.",
};

const LABEL: Record<PromotionAction, [string, string]> = {
  activate: ["Activate", "Activating…"],
  pause: ["Pause", "Pausing…"],
  end: ["End promotion", "Ending…"],
};

/** The status buttons that make sense for where the promotion is now. */
function actionsFor(p: Promotion): PromotionAction[] {
  if (p.status === "draft") return ["activate"];
  if (p.status === "paused") return ["activate", "end"];
  if (p.status === "active") return ["pause", "end"];
  return [];
}

/**
 * Activate, pause, end and edit. Each change is sent with the version this
 * page was loaded with, so a change made elsewhere meanwhile is refused
 * rather than overwritten; only the server's answer updates the page.
 */
export function PromotionActions({ promotion }: { promotion: Promotion }) {
  const router = useRouter();
  const [busy, setBusy] = useState<PromotionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = actionsFor(promotion);
  const editable = promotion.status === "draft" || promotion.status === "paused";

  async function run(action: PromotionAction) {
    if (busy || !window.confirm(CONFIRM[action])) return;
    setBusy(action);
    setError(null);
    const res = await changePromotionStatus(promotion.id, action, promotion.version);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.replace(`/market/promotions/${promotion.id}?saved=${action}`);
    router.refresh();
  }

  if (!actions.length && !editable) return null;
  return (
    <div className="space-y-3">
      {error && <FormAlert>{error}</FormAlert>}
      <div className="grid grid-cols-2 gap-3">
        {editable && (
          <Link href={`/market/promotions/${promotion.id}/edit`} className={buttonClasses("outline")}>
            Edit
          </Link>
        )}
        {actions.map((action) => (
          <Button
            key={action}
            type="button"
            variant={action === "activate" ? "solid" : "outline"}
            className={action === "end" ? "text-red-600 hover:text-red-700" : undefined}
            loading={busy === action}
            disabled={busy !== null}
            onClick={() => run(action)}
          >
            {LABEL[action][busy === action ? 1 : 0]}
          </Button>
        ))}
      </div>
    </div>
  );
}
