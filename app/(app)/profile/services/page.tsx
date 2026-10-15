import type { Metadata } from "next";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { ServicesManager } from "@/components/services/services-manager";
import { Icon } from "@/components/ui/icons";
import { offersServices, SERVICES_INTRO } from "@/lib/services/config";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { listServices } from "@/lib/server/services";

export const metadata: Metadata = { title: "Services & Pricing" };

const SAVED_NOTICE: Record<string, string> = {
  added: "Service added.",
  updated: "Changes saved.",
};

// The signed-in user's own services, read straight from the database for the
// account in the session. If the read fails, error.tsx offers a retry.
export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const canList = offersServices(user.role);
  const services = canList ? await listServices(user._id) : [];
  const saved = (await searchParams).saved;
  const notice = typeof saved === "string" && Object.hasOwn(SAVED_NOTICE, saved) ? SAVED_NOTICE[saved] : null;
  const intro = SERVICES_INTRO[user.role];

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Services & Pricing" back={<BackLink href="/profile" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <h2 className="text-xl font-semibold tracking-tight">{intro.heading}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{intro.description}</p>
        <p className="mt-3 mb-5 flex gap-2 rounded-xl bg-primary/6 px-3.5 py-2.5 text-xs leading-relaxed text-primary">
          <Icon name="calendar" className="mt-px size-4 shrink-0" />
          Bookings aren&apos;t open yet. Services that are active and available for booking will be bookable when
          they launch.
        </p>

        {canList ? (
          <ServicesManager role={user.role} initialServices={services} notice={notice} />
        ) : (
          <div className="flex flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-foreground/5">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-foreground/6 text-foreground/50">
              <Icon name="list" className="size-7" />
            </div>
            <h3 className="mt-4 text-base font-semibold">Services aren&apos;t available for your account</h3>
            <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Your account type can&apos;t list services yet. If you think this is a mistake, contact support.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
