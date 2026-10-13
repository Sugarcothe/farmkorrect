import type { ReactNode } from "react";
import { BottomNav } from "@/components/app/bottom-nav";
import { PROFILE_CONFIG } from "@/lib/profile/config";
import { requireVerifiedPageSession } from "@/lib/server/auth";

// Shell for the signed-in app: a phone-width column (a centred card on larger
// screens) with the role's bottom navigation. Each page still checks the
// session itself; a layout isn't re-run on every navigation.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user } = await requireVerifiedPageSession();

  return (
    <div className="flex flex-1 flex-col bg-surface md:items-center md:justify-center md:bg-primary/5 md:p-8">
      <div className="flex w-full flex-1 flex-col bg-surface md:h-[min(880px,calc(100dvh-4rem))] md:max-w-[420px] md:flex-none md:overflow-hidden md:rounded-[2.5rem] md:shadow-2xl md:shadow-primary/15">
        <div className="flex flex-1 flex-col md:overflow-y-auto">{children}</div>
        <BottomNav tabs={PROFILE_CONFIG[user.role].tabs} />
      </div>
    </div>
  );
}
