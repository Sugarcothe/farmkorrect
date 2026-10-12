import { ComingSoon } from "@/components/home/coming-soon";
import { SignOutButton } from "@/components/home/sign-out-button";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export default async function Home() {
  const { user } = await requireVerifiedPageSession();
  const firstName = user.fullName.trim().split(/\s+/)[0];

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-8 text-center">
      <ComingSoon firstName={firstName} />
      <SignOutButton />
    </main>
  );
}
