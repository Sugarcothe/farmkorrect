import type { Metadata } from "next";
import Link from "next/link";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { StaffManager } from "@/components/training/staff-manager";
import { buttonClasses } from "@/components/ui/button";
import { EmptyList } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findOwnFarm, getStaffOverview, programCourseOptions } from "@/lib/server/training-staff";

export const metadata: Metadata = { title: "Staff Training Programs" };

// Staff Training for the signed-in owner's own farm (from the session). Staff
// are people who accepted an invitation sent to their verified phone number.
export default async function StaffTrainingPage() {
  const { user } = await requireVerifiedPageSession();
  const farm = await findOwnFarm(user);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Staff Training Programs" back={<BackLink href="/training" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        {farm ? (
          <StaffSection user={user} />
        ) : (
          <>
            <EmptyList icon="users" title="Set up your farm first">
              Staff training is for farm owners. Add your farm profile, then invite your staff.
            </EmptyList>
            <Link href="/farm-setup" className={buttonClasses("solid", "mt-4")}>
              Set up your farm
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

async function StaffSection({ user }: { user: Parameters<typeof getStaffOverview>[0] }) {
  const [overview, options] = await Promise.all([getStaffOverview(user), programCourseOptions()]);
  return (
    <>
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
        Assign courses to each role on {overview.farmName}. Staff see their programme in Training once they accept your
        invitation.
      </p>
      <StaffManager overview={overview} options={options} />
    </>
  );
}
