import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, ProfileAvatar, ProfileTopBar } from "@/components/profile/profile-parts";
import { CredentialsBadge, Section, ServiceCardView } from "@/components/services/service-parts";
import { Icon } from "@/components/ui/icons";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getServiceProvider } from "@/lib/server/service-directory";

export const metadata: Metadata = { title: "Provider" };

// A provider's public page: what they chose to show on their profile and
// their listed services. No phone number, ratings or job counts. Anyone
// without a listed service is a 404.
export default async function ServiceProviderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireVerifiedPageSession();
  const p = await getServiceProvider((await params).id);
  if (!p) notFound();

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Provider" back={<BackLink href="/services" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <section className="flex flex-col items-center rounded-3xl bg-white px-5 py-6 text-center shadow-sm ring-1 ring-foreground/5">
          <ProfileAvatar photoUrl={p.photoUrl} name={p.name} />
          <h2 className="mt-3 text-lg font-semibold">{p.name}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[p.roleLabel, p.yearsOfExperience !== null ? `${p.yearsOfExperience} yrs experience` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {p.credentialsVerified && (
            <div className="mt-2">
              <CredentialsBadge />
            </div>
          )}
          {p.location && (
            <p className="mt-3 flex items-center gap-1 text-sm text-foreground/75">
              <Icon name="map-pin" className="size-4" />
              {p.location}
            </p>
          )}
        </section>

        {p.bio && (
          <Section title="About">
            <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/80">{p.bio}</p>
          </Section>
        )}

        <h2 className="text-sm font-semibold">Services</h2>
        <ul className="flex flex-col gap-3">
          {p.services.map((s) => (
            <li key={s.id}>
              <ServiceCardView service={s} />
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
