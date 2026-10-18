import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink, ProfileAvatar, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { durationLabel, HoursList, placeLabel, priceLabel, ReviewedBadge, Section } from "@/components/vets/vet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getVetProfile } from "@/lib/server/vet-directory";
import { formatSlot } from "@/lib/vets/schedule";

export const metadata: Metadata = { title: "Vet profile" };

// A listed vet's public profile. Only what they chose to show: no phone
// number, registration number, qualification documents or internal notes.
// A vet who isn't bookable right now (unlisted, unapproved, no open
// service) is a 404, the same as an unknown id.
export default async function VetProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const vet = await getVetProfile((await params).id);
  if (!vet) notFound();
  const place = placeLabel(vet.state, vet.area);
  const isSelf = user._id.toHexString() === vet.id;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Vet profile" back={<BackLink href="/vets" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <section className="flex flex-col items-center rounded-3xl bg-white px-5 py-6 text-center shadow-sm ring-1 ring-foreground/5">
          <ProfileAvatar photoUrl={vet.photoUrl} name={vet.name} />
          <h2 className="mt-3 text-lg font-semibold">{vet.name}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[
              vet.specialization ?? "Veterinarian",
              vet.yearsOfExperience !== null ? `${vet.yearsOfExperience} yrs experience` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="mt-2">
            <ReviewedBadge />
          </div>
          <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">
            The Farm Korret team reviewed this vet&rsquo;s registration details. This isn&rsquo;t a live check against
            the Veterinary Council of Nigeria&rsquo;s register.
          </p>
          {place && (
            <p className="mt-3 flex items-center gap-1 text-sm text-foreground/75">
              <Icon name="map-pin" className="size-4" />
              {place}
            </p>
          )}
          <p className="mt-1 flex items-center gap-1 text-sm text-foreground/75">
            <Icon name="clock" className="size-4" />
            {vet.nextOpenSlot ? `Next open time: ${formatSlot(vet.nextOpenSlot)}` : "No open times in the next 14 days"}
          </p>
          <dl className="mt-4 grid w-full grid-cols-3 gap-2">
            <Stat
              label="Experience"
              value={vet.yearsOfExperience !== null ? `${vet.yearsOfExperience} yrs` : "Not given"}
            />
            <Stat label="Services" value={String(vet.services.length)} />
            <Stat label="Working days" value={`${vet.workingHours.length} / week`} />
          </dl>
          {!isSelf && (
            <Link href={`/vets/${vet.id}/book`} className={buttonClasses("solid", "mt-4")}>
              Book appointment
            </Link>
          )}
        </section>

        {vet.bio && (
          <Section title="About">
            <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/80">{vet.bio}</p>
          </Section>
        )}

        <Section title="Services offered">
          <ul className="divide-y divide-foreground/6">
            {vet.services.map((s) => (
              <li key={s.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.categoryLabel} · {durationLabel(s.durationMinutes)}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{priceLabel(s.priceNgn)}</span>
                </div>
                {s.description && <p className="mt-1.5 text-xs leading-relaxed text-foreground/70">{s.description}</p>}
                {!isSelf && (
                  <Link
                    href={`/vets/${vet.id}/book?service=${s.id}`}
                    className={buttonClasses("outline", "mt-2.5 h-10 text-sm")}
                    aria-label={`Book ${s.name}`}
                  >
                    Book this service
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Working hours (Lagos time)">
          <HoursList hours={vet.workingHours} />
        </Section>

        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {isSelf
            ? "This is how customers see your listing. You can't book your own services."
            : "There are no customer reviews for vets yet. Ratings will appear here once they're collected."}
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-foreground/[0.03] px-2 py-2.5">
      <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold">{value}</dd>
    </div>
  );
}
