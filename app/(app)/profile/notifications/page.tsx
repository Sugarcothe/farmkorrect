import type { Metadata } from "next";
import { PreferencesForm } from "@/components/notifications/preferences-form";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getPreferencesResponse } from "@/lib/server/notifications";

export const metadata: Metadata = { title: "Notification Settings" };

// Where the signed-in user chooses how they hear about each kind of event.
// The settings and which channels can reach them come from the server.
export default async function NotificationSettingsPage() {
  const { user } = await requireVerifiedPageSession();
  const initial = await getPreferencesResponse(user);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Notifications" back={<BackLink href="/profile" />} action={<NotificationBell />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <PreferencesForm initial={initial} />
      </div>
    </main>
  );
}
