import Image from "next/image";
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icons";
import { SITE } from "@/lib/site";
import { LandingActions } from "./landing-auth";

// The desktop front page (shown from the lg breakpoint; phones get the
// splash and onboarding instead). Everything said here describes what the
// app actually does: no invented figures, testimonials or prices.

const NAV = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#professionals", label: "For professionals" },
  { href: "#faq", label: "FAQ" },
];

const PILLARS: { icon: IconName; label: string }[] = [
  { icon: "store", label: "Poultry market" },
  { icon: "stethoscope", label: "Verified vets" },
  { icon: "wrench", label: "Farm services" },
  { icon: "graduation-cap", label: "Training" },
];

const AUDIENCES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "egg",
    title: "Poultry farmers",
    body: "Sell your eggs and birds, buy from other farmers, book a vet and learn new skills.",
  },
  {
    icon: "stethoscope",
    title: "Veterinarians",
    body: "Get found by farmers who need you, set your availability and manage appointments.",
  },
  {
    icon: "briefcase",
    title: "Farm specialists",
    body: "Offer your services, from farm setup to consulting, and take bookings in one place.",
  },
];

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "store",
    title: "Market",
    body: "Buy and sell live birds, eggs, day-old chicks, dressed chicken and more. Search and filter by state, with seller reviews.",
  },
  {
    icon: "stethoscope",
    title: "Find a vet",
    body: "Browse veterinarians by specialization and location. Every vet listed has had their credentials approved by our team.",
  },
  {
    icon: "wrench",
    title: "Farm services",
    body: "Find specialists for the work your farm needs, compare what they offer and book them directly.",
  },
  {
    icon: "graduation-cap",
    title: "Training",
    body: "Practical courses on poultry health and farm management that you can follow at your own pace.",
  },
  {
    icon: "wallet",
    title: "Wallet and payouts",
    body: "Sellers and professionals see what they've earned and withdraw it to their own Nigerian bank account.",
  },
  {
    icon: "bell",
    title: "Updates as they happen",
    body: "Notifications for orders, bookings and payments, so you always know what's next.",
  },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Sign up with your phone", body: "Choose your role and confirm your number with a one-time code." },
  { title: "Set up your profile", body: "Tell us about your farm or your practice so the right people find you." },
  { title: "Buy, sell, book or learn", body: "Use the market, find a vet or specialist, or start a course." },
  {
    title: "Pay securely and track it",
    body: "Payments go through Paystack and you follow every order and booking in the app.",
  },
];

const PRO_POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "users",
    title: "Get found",
    body: "Your profile, specialization and reviews appear in the directory farmers search.",
  },
  {
    icon: "calendar",
    title: "Manage your jobs",
    body: "Set when you're available, accept or decline requests and keep track of every job.",
  },
  {
    icon: "landmark",
    title: "Get paid to your bank",
    body: "Earnings from completed jobs collect in your wallet and are paid out to your bank account.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Who can join Farm Korret?",
    a: "Poultry farmers, veterinarians and other farm specialists. You choose your role when you sign up.",
  },
  {
    q: "How do you check veterinarians?",
    a: "Vets submit their registration number and qualifications. They only appear in Find a Vet after the Farm Korret team approves them.",
  },
  {
    q: "How do payments work?",
    a: "Payments are made through Paystack. An order or booking is only marked as paid once our server has confirmed the payment.",
  },
  {
    q: "How do sellers and professionals get paid?",
    a: "Add your bank details in your profile. Your earnings collect in your wallet and you withdraw them to that account.",
  },
  {
    q: "Who handles delivery?",
    a: "Sellers choose pickup or arrange delivery themselves. Farm Korret never adds a delivery fee of its own.",
  },
  {
    q: "Can I use it on my phone?",
    a: "Yes. Open Farm Korret in your phone's browser and add it to your home screen to use it like an app.",
  },
];

function SectionHeading({
  eyebrow,
  title,
  body,
  center,
}: {
  eyebrow: string;
  title: string;
  body?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <p className="text-sm font-semibold tracking-wide text-accent uppercase">{eyebrow}</p>
      <h2 className="mt-2 text-4xl leading-tight font-semibold tracking-tight">{title}</h2>
      {body && <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{body}</p>}
    </div>
  );
}

const container = "mx-auto w-full max-w-7xl px-10";

export function LandingPage() {
  const year = new Date().getFullYear();
  return (
    <div className="hidden bg-white text-foreground lg:block">
      <header className="sticky top-0 z-30 bg-primary-dark/95 text-white backdrop-blur">
        <div className={`${container} flex h-18 items-center justify-between gap-8`}>
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <span className="relative size-9 overflow-hidden rounded-xl bg-white">
              <Image src="/farm-korret-logo.png" alt="" fill sizes="36px" />
            </span>
            <span className="text-lg font-semibold">{SITE.shortName}</span>
          </Link>
          <nav aria-label="Page sections">
            <ul className="flex items-center gap-8 text-sm text-white/75">
              {NAV.map((n) => (
                <li key={n.href}>
                  <a
                    href={n.href}
                    className="rounded outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white"
                  >
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <LandingActions />
        </div>
      </header>

      <main>
        {/* hero */}
        <section className="bg-primary-dark text-white">
          <div className={`${container} grid grid-cols-[1.25fr_1fr] items-center gap-12 pt-16 pb-20`}>
            <div>
              <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 text-sm text-white/85">
                <Icon name="map-pin" className="size-4" />
                Built for poultry farming in Nigeria
              </p>
              <h1 className="mt-6 text-[3.5rem] leading-[1.05] font-semibold tracking-tight xl:text-7xl">
                Everything poultry,
                <br />
                <span className="text-highlight">one app.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/75">
                Sell your eggs and birds, find a verified vet, book farm services and learn from experts, all from a
                single account.
              </p>
              <div className="mt-9">
                <LandingActions size="lg" />
              </div>
            </div>
            <div className="relative">
              <div className="relative ml-auto aspect-[4/5] max-h-[560px] w-full max-w-[460px] overflow-hidden rounded-[2rem] bg-primary shadow-2xl shadow-black/40">
                <Image
                  src="/slide-1.png"
                  alt="Smiling farmer in a straw hat and overalls standing in a barn"
                  fill
                  sizes="460px"
                  className="object-cover object-top"
                />
              </div>
              <div className="absolute bottom-10 left-0 flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-foreground shadow-xl xl:-left-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary/8 text-primary">
                  <Icon name="stethoscope" className="size-5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">Book a verified vet</span>
                  <span className="block text-xs text-muted-foreground">Approved by our team</span>
                </span>
              </div>
              <div className="absolute top-10 right-0 flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-foreground shadow-xl xl:-right-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                  <Icon name="egg" className="size-5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">Sell eggs and birds</span>
                  <span className="block text-xs text-muted-foreground">On the Farm Korret market</span>
                </span>
              </div>
            </div>
          </div>
          <div className="border-t border-white/10">
            <ul className={`${container} grid grid-cols-4 py-5 text-sm text-white/70`}>
              {PILLARS.map((p) => (
                <li key={p.label} className="flex items-center justify-center gap-2">
                  <Icon name={p.icon} className="size-4 text-highlight" />
                  {p.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* who it's for */}
        <section className={`${container} grid grid-cols-2 items-center gap-16 py-24`}>
          <div className="relative aspect-[4/3] overflow-hidden rounded-[2rem] bg-primary/8">
            <Image
              src="/slide-2.jpg"
              alt="Bright poultry house with chickens, feeders and drinkers in neat rows"
              fill
              sizes="600px"
              className="object-cover"
            />
          </div>
          <div>
            <SectionHeading
              eyebrow="Who it's for"
              title="One place for the whole poultry business"
              body="Farm Korret connects the people a poultry farm depends on. Farmers, vets and specialists each get tools built for the work they do."
            />
            <ul className="mt-8 space-y-4">
              {AUDIENCES.map((a) => (
                <li key={a.title} className="flex gap-4 rounded-2xl bg-surface p-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                    <Icon name={a.icon} className="size-5" />
                  </span>
                  <span>
                    <span className="block font-semibold">{a.title}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">{a.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* features */}
        <section id="features" className="scroll-mt-20 bg-surface py-24">
          <div className={container}>
            <SectionHeading
              center
              eyebrow="Features"
              title="What you can do on Farm Korret"
              body="Everything below works today, on your phone or your computer."
            />
            <ul className="mt-14 grid grid-cols-3 gap-6">
              {FEATURES.map((f) => (
                <li key={f.title} className="rounded-3xl bg-white p-7 shadow-sm ring-1 ring-foreground/5">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/8 text-primary">
                    <Icon name={f.icon} className="size-6" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* how it works */}
        <section id="how-it-works" className={`${container} scroll-mt-20 py-24`}>
          <SectionHeading center eyebrow="How it works" title="Up and running in minutes" />
          <ol className="relative mt-16 grid grid-cols-4 gap-8">
            <span aria-hidden="true" className="absolute top-6 right-[12.5%] left-[12.5%] h-px bg-primary/15" />
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground ring-8 ring-white">
                  {i + 1}
                </span>
                <h3 className="mt-5 font-semibold">{s.title}</h3>
                <p className="mx-auto mt-2 max-w-[15rem] text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* professionals */}
        <section id="professionals" className="scroll-mt-20 bg-primary-dark py-24 text-white">
          <div className={`${container} grid grid-cols-[1fr_1.4fr] items-start gap-16`}>
            <div>
              <p className="text-sm font-semibold tracking-wide text-highlight uppercase">For professionals</p>
              <h2 className="mt-2 text-4xl leading-tight font-semibold tracking-tight">
                Vets and farm specialists, grow your practice
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-white/70">
                Farmers across Nigeria come to Farm Korret looking for help. Set up your profile and let them book you.
              </p>
              <div className="mt-8">
                <LandingActions />
              </div>
            </div>
            <ul className="grid gap-4">
              {PRO_POINTS.map((p) => (
                <li key={p.title} className="flex gap-5 rounded-3xl bg-white/5 p-6 ring-1 ring-white/10">
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-highlight text-primary-dark">
                    <Icon name={p.icon} className="size-6" />
                  </span>
                  <span>
                    <span className="block text-lg font-semibold">{p.title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-white/70">{p.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* faq */}
        <section id="faq" className={`${container} scroll-mt-20 py-24`}>
          <SectionHeading center eyebrow="FAQ" title="Questions farmers ask" />
          <div className="mx-auto mt-14 grid max-w-5xl grid-cols-2 gap-x-6 gap-y-4">
            {FAQ.map((f) => (
              <details key={f.q} className="group rounded-2xl bg-surface px-6 py-5 open:bg-primary/5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <Icon
                    name="chevron-down"
                    className="size-5 shrink-0 text-primary transition-transform group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* closing call to action */}
        <section className={`${container} pb-24`}>
          <div className="flex items-center justify-between gap-10 rounded-[2rem] bg-primary px-14 py-14 text-white">
            <div>
              <h2 className="text-4xl leading-tight font-semibold tracking-tight">
                Ready to grow your poultry business?
              </h2>
              <p className="mt-3 text-lg text-white/75">Join with your phone number in a couple of minutes.</p>
            </div>
            <div className="shrink-0">
              <LandingActions size="lg" />
            </div>
          </div>
        </section>
      </main>

      <footer className="overflow-hidden bg-primary-dark text-white">
        <div className={`${container} grid grid-cols-[2fr_1fr_1fr] gap-10 pt-16 pb-10`}>
          <div>
            <p className="text-lg font-semibold">{SITE.name}</p>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-white/60">{SITE.description}</p>
          </div>
          <div>
            <p className="text-sm font-semibold">Explore</p>
            <ul className="mt-3 space-y-2 text-sm text-white/60">
              {NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href} className="hover:text-white">
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-semibold">Account</p>
            <ul className="mt-3 space-y-2 text-sm text-white/60">
              <li>
                <Link href="/auth/choose-role" className="hover:text-white">
                  Create an account
                </Link>
              </li>
              <li>
                <Link href="/auth/sign-in" className="hover:text-white">
                  Sign in
                </Link>
              </li>
              <li>
                <Link href="/auth/forgot-password" className="hover:text-white">
                  Forgot password
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className={`${container} border-t border-white/10 py-6 text-xs text-white/50`}>
          © {year} {SITE.name}. All rights reserved.
        </div>
        <p
          aria-hidden="true"
          className="-mb-[0.22em] text-center text-[13vw] leading-none font-extrabold tracking-tighter text-white/[0.06] select-none"
        >
          FARM KORRET
        </p>
      </footer>
    </div>
  );
}
