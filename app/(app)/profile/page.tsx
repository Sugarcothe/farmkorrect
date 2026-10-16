import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { LogOutRow } from "@/components/profile/log-out-row";
import {
  MenuRowContent,
  menuRowClass,
  ProfileAvatar,
  ProfileTopBar,
  VerificationBadge,
} from "@/components/profile/profile-parts";
import { Icon, type IconName } from "@/components/ui/icons";
import { FARM_TYPE_LABELS } from "@/lib/auth/types";
import { PROFILE_CONFIG, SECTION_INFO, specializationLabel } from "@/lib/profile/config";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { SELLER_ROLE } from "@/lib/server/products";
import { getProfile } from "@/lib/server/profile";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const profile = await getProfile(user);
  const config = PROFILE_CONFIG[profile.role];
  const justSaved = (await searchParams).updated === "1";
  const marketRows: { href: string; label: string; icon: IconName }[] = [
    { href: "/orders", label: "My Orders", icon: "list" },
    ...(profile.role === SELLER_ROLE
      ? [
          { href: "/market/listings", label: "My Listings", icon: "store" as const },
          { href: "/sales", label: "Sales", icon: "wallet" as const },
        ]
      : [{ href: "/market", label: "Market", icon: "store" as const }]),
  ];

  const specialization = specializationLabel(profile.role, profile.specialization);
  const years =
    profile.yearsOfExperience === null
      ? null
      : `${profile.yearsOfExperience} ${profile.yearsOfExperience === 1 ? "year" : "years"} experience`;

  return (
    <main className="flex flex-1 flex-col pb-6">
      <ProfileTopBar title="Profile" />

      <section aria-label="Your profile" className="px-5">
        <div className="flex flex-col items-center rounded-3xl bg-white px-5 pt-6 pb-5 text-center shadow-sm ring-1 ring-foreground/5">
          <ProfileAvatar photoUrl={profile.photoUrl} name={profile.fullName} />
          <h2 className="mt-3 text-xl font-bold tracking-tight">{profile.fullName}</h2>
          <p className="mt-0.5 text-sm font-medium text-primary">
            {specialization ? `${config.title} · ${specialization}` : config.title}
          </p>
          {(years || profile.location) && (
            <p className="mt-1.5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              {years && <span>{years}</span>}
              {years && profile.location && <span aria-hidden="true">·</span>}
              {profile.location && (
                <span className="inline-flex items-center gap-1">
                  <Icon name="map-pin" className="size-3.5" />
                  {profile.location}
                </span>
              )}
            </p>
          )}
          <div className="mt-3">
            <VerificationBadge credential={config.hasCredential ? profile.credentialStatus : null} />
          </div>
          {profile.farm && (
            <p className="mt-3 text-sm text-foreground/75">
              {profile.farm.farmName} · {FARM_TYPE_LABELS[profile.farm.farmType]} ·{" "}
              {profile.farm.birdCount.toLocaleString("en-NG")} birds
            </p>
          )}
          {profile.bio && (
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-foreground/75">
              {profile.bio}
            </p>
          )}
        </div>

        {justSaved && (
          <div className="mt-4">
            <FormAlert tone="success">Your profile has been updated.</FormAlert>
          </div>
        )}
      </section>

      <nav aria-label="Profile settings" className="mt-5 px-5">
        <ul className="divide-y divide-foreground/6 overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
          <li>
            <Link href="/profile/edit" className={menuRowClass}>
              <MenuRowContent icon="pencil" label="Edit Profile" />
            </Link>
          </li>
          {marketRows.map((row) => (
            <li key={row.href}>
              <Link href={row.href} className={menuRowClass}>
                <MenuRowContent icon={row.icon} label={row.label} />
              </Link>
            </li>
          ))}
          {config.sections.map((section) => (
            <li key={section}>
              <Link href={`/profile/${section}`} className={menuRowClass}>
                <MenuRowContent
                  icon={SECTION_INFO[section].icon}
                  label={SECTION_INFO[section].title}
                  soon={!SECTION_INFO[section].ready}
                />
              </Link>
            </li>
          ))}
          <li>
            <LogOutRow />
          </li>
        </ul>
      </nav>
    </main>
  );
}
