import type { ReactNode } from "react";
import { BottomNav } from "@/components/app/bottom-nav";
import { SideNav } from "@/components/app/side-nav";
import { PROFILE_CONFIG } from "@/lib/profile/config";
import { requireVerifiedPageSession } from "@/lib/server/auth";

// Shell for the signed-in app: on phones a full-screen column with the role's
// bottom navigation; from the lg breakpoint a sidebar with the same tabs and a
// wide content area (see .app-content in globals.css for page widths). Each
// page still checks the session itself; a layout isn't re-run on every
// navigation.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user } = await requireVerifiedPageSession();
  const config = PROFILE_CONFIG[user.role];

  return (
    <div className="flex flex-1 flex-col bg-surface lg:flex-row">
      <SideNav tabs={config.tabs} name={user.fullName.trim()} roleTitle={config.title} />
      <div className="app-content flex min-w-0 flex-1 flex-col">{children}</div>
      <BottomNav tabs={config.tabs} />
    </div>
  );
}
