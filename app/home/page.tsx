import { SignOutButton } from "@/components/home/sign-out-button";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export default async function Home() {
  const { user } = await requireVerifiedPageSession();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          You&apos;re in 🎉
        </h1>
        <p className="text-sm text-foreground/60">
          Signed in as {user.fullName}. The farm dashboard goes here next.
        </p>
      </div>
      <SignOutButton />
    </main>
  );
}
