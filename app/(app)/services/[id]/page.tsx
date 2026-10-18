import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink, ProfileAvatar, ProfileTopBar } from "@/components/profile/profile-parts";
import { bookLabel, CredentialsBadge, Fact, Section, servicePrice } from "@/components/services/service-parts";
import { buttonClasses } from "@/components/ui/button";
import { durationLabel } from "@/components/vets/vet-parts";
import { stateLabel } from "@/lib/locations/nigeria";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getMarketplaceService } from "@/lib/server/service-directory";

export const metadata: Metadata = { title: "Service" };

// A listed marketplace service. Only the fields the provider filled in: no
// ratings, job counts, distances or arrival times. Unlisted, removed and
// unknown services are the same 404.
export default async function ServiceDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const s = await getMarketplaceService((await params).id, user._id);
  if (!s) notFound();

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Service details" back={<BackLink href="/services" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <section className="rounded-3xl bg-white px-5 py-5 shadow-sm ring-1 ring-foreground/5">
          <p className="text-[0.6875rem] font-semibold tracking-wide text-primary uppercase">{s.categoryLabel}</p>
          <h2 className="mt-1 text-lg font-semibold">{s.name}</h2>
          <p className="mt-1 text-xl font-semibold text-primary tabular-nums">{servicePrice(s)}</p>
          {s.pricing === "quote" && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              The provider prices the job after you describe it. You pay only if you accept.
            </p>
          )}
          <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-foreground/80">{s.description}</p>
          {s.canBook ? (
            <Link href={`/services/${s.id}/book`} className={buttonClasses("solid", "mt-4")}>
              {bookLabel(s.pricing)}
            </Link>
          ) : (
            <p className="mt-4 rounded-2xl bg-foreground/5 px-3 py-2.5 text-sm text-foreground/70">
              This is your own service. Manage it from{" "}
              <Link href="/profile/services" className="font-medium text-primary underline-offset-2 hover:underline">
                Services &amp; Pricing
              </Link>
              .
            </p>
          )}
        </section>

        <Section title="Details">
          <dl className="space-y-1.5 text-sm">
            <Fact label="Duration" value={durationLabel(s.durationMinutes)} />
            <Fact label="Covers" value={s.serviceStates.map(stateLabel).join(", ")} />
          </dl>
        </Section>

        {s.included && (
          <Section title="What's included">
            <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/80">{s.included}</p>
          </Section>
        )}
        {s.excluded && (
          <Section title="What's not included">
            <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/80">{s.excluded}</p>
          </Section>
        )}
        {s.requirements && (
          <Section title="What you'll need to provide">
            <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/80">{s.requirements}</p>
          </Section>
        )}

        <Section title="Provider">
          <Link
            href={`/services/providers/${s.provider.id}`}
            className="flex items-center gap-3 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ProfileAvatar photoUrl={s.provider.photoUrl} name={s.provider.name} className="size-11 text-sm ring-2" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.provider.name}</span>
              <span className="block text-xs text-muted-foreground">{s.provider.roleLabel}</span>
            </span>
            {s.provider.credentialsVerified && <CredentialsBadge />}
          </Link>
        </Section>
      </div>
    </main>
  );
}
