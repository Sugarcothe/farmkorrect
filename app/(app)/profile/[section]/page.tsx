import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { isProfileSection, PROFILE_CONFIG, SECTION_INFO } from "@/lib/profile/config";
import { requireVerifiedPageSession } from "@/lib/server/auth";

type Props = { params: Promise<{ section: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params;
  return { title: isProfileSection(section) ? SECTION_INFO[section].title : "Profile" };
}

// Profile areas that aren't built yet. Only the sections listed for the
// user's role exist; anything else is a 404.
export default async function ProfileSectionPage({ params }: Props) {
  const { user } = await requireVerifiedPageSession();
  const { section } = await params;
  if (!isProfileSection(section) || !PROFILE_CONFIG[user.role].sections.includes(section)) notFound();
  const info = SECTION_INFO[section];

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={info.title} back={<BackLink href="/profile" />} />
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/8 text-primary">
          <Icon name={info.icon} className="size-8" />
        </div>
        <span className="mt-5 inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold tracking-wider text-primary uppercase">
          Coming soon
        </span>
        <h2 className="mt-3 text-xl font-semibold tracking-tight">{info.title}</h2>
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{info.blurb}</p>
        <Link href="/profile" className={buttonClasses("outline", "mt-8 max-w-xs")}>
          Back to Profile
        </Link>
      </div>
    </main>
  );
}
