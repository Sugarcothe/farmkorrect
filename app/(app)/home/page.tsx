import { Dashboard } from "@/components/home/dashboard";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { dashboardActions, greetingFor, type DashboardStatsResult } from "@/lib/home/dashboard";
import { PROFILE_CONFIG } from "@/lib/profile/config";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { dashboardAccess, dashboardStats, dashboardSubtitle } from "@/lib/server/dashboard";
import type { UserDoc } from "@/lib/server/models";

const failed = (what: string, error: unknown) =>
  console.error(`[home] ${what} failed: ${error instanceof Error ? error.name : typeof error}`);

async function subtitleFor(user: UserDoc) {
  try {
    return await dashboardSubtitle(user);
  } catch (error) {
    failed("subtitle", error);
    return PROFILE_CONFIG[user.role].title;
  }
}

// The signed-in home dashboard: everything is read for the session's own
// user. If the figures can't be read the page says so; Quick Actions still
// work.
export default async function Home() {
  const { user } = await requireVerifiedPageSession();
  const now = new Date();
  const access = await dashboardAccess(user);
  const [subtitle, stats] = await Promise.all([
    subtitleFor(user),
    dashboardStats(user, access, now).catch((error: unknown): DashboardStatsResult => {
      failed("stats", error);
      return "unavailable";
    }),
  ]);

  return (
    <Dashboard
      greeting={greetingFor(now)}
      name={user.fullName.trim()}
      subtitle={subtitle}
      stats={stats}
      actions={dashboardActions(access)}
      bell={<NotificationBell onPrimary />}
    />
  );
}
