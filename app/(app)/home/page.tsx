import { ComingSoon } from "@/components/home/coming-soon";
import { SignOutButton } from "@/components/home/sign-out-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export default async function Home() {
  const { user } = await requireVerifiedPageSession();
  const firstName = user.fullName.trim().split(/\s+/)[0];

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-8 px-8 py-10 text-center">
      <div className="absolute top-2 right-3">
        <NotificationBell />
      </div>
      <ComingSoon firstName={firstName} />
      <SignOutButton />
    </main>
  );
}
