import Link from "next/link";
import { ComingSoon } from "@/components/home/coming-soon";
import { SignOutButton } from "@/components/home/sign-out-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { buttonClasses } from "@/components/ui/button";
import { AppointmentRow } from "@/components/vets/vet-parts";
import { listAppointments } from "@/lib/server/appointments";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export default async function Home() {
  const { user } = await requireVerifiedPageSession();
  const firstName = user.fullName.trim().split(/\s+/)[0];
  const recent = (await listAppointments(user, "customer", null)).appointments.slice(0, 2);

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-8 px-8 py-10 text-center">
      <div className="absolute top-2 right-3">
        <NotificationBell />
      </div>
      <ComingSoon firstName={firstName} />
      <nav aria-label="Vet appointments" className="flex w-full max-w-xs flex-col gap-3">
        <Link href="/vets" className={buttonClasses("solid")}>
          Find a vet
        </Link>
        <Link href="/appointments" className={buttonClasses("outline")}>
          My appointments
        </Link>
        {user.role === "veterinarian" && (
          <Link href="/jobs" className={buttonClasses("outline")}>
            Jobs booked with me
          </Link>
        )}
      </nav>
      {recent.length > 0 && (
        <section aria-labelledby="recent-bookings" className="w-full max-w-xs text-left">
          <h2 id="recent-bookings" className="mb-2 text-sm font-semibold">
            Recent bookings
          </h2>
          <ul className="overflow-hidden rounded-2xl bg-white ring-1 ring-foreground/8">
            {recent.map((a) => (
              <AppointmentRow key={a.id} appointment={a} href={`/appointments/${a.id}`} />
            ))}
          </ul>
        </section>
      )}
      <SignOutButton />
    </main>
  );
}
