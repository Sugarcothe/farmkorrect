import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { ServiceDirectory } from "@/components/services/service-directory";
import { Icon } from "@/components/ui/icons";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { searchServiceDirectory } from "@/lib/server/service-directory";
import { MARKETPLACE_ROLES } from "@/lib/services/config";
import {
  parseServiceQuery,
  SERVICE_DIRECTORY_PAGE_SIZE,
  serviceQueryParams,
  type ServiceDirectoryPage,
  type ServiceDirectoryQuery,
} from "@/lib/services/marketplace";

export const metadata: Metadata = { title: "Services" };

type RawParams = Record<string, string | string[] | undefined>;

async function firstPage(query: ServiceDirectoryQuery): Promise<ServiceDirectoryPage | null> {
  try {
    return await searchServiceDirectory(query, null, SERVICE_DIRECTORY_PAGE_SIZE);
  } catch (error) {
    console.error(`[services] directory search failed: ${error instanceof Error ? error.name : typeof error}`);
    return null;
  }
}

const linkClass =
  "flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2.5 text-[0.8125rem] font-medium text-primary ring-1 ring-foreground/8 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent";

// Other Services: farm services anyone can book — fumigation, recruitment,
// transport, logistics, sales connection, installation and maintenance. The
// filters are in the address; the first page is read here, later pages by
// the browser through /api/service-directory (see docs/other-services.md).
// A provider's own list stays at /profile/services.
export default async function ServicesPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const { user } = await requireVerifiedPageSession();
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw))
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  const { query } = parseServiceQuery(params);
  // unknown or invalid values: show the address that matches what's on screen
  const canonical = serviceQueryParams(query).toString();
  if (canonical !== params.toString()) redirect(canonical ? `/services?${canonical}` : "/services");

  const page = await firstPage(query);
  const provides = MARKETPLACE_ROLES[user.role].length > 0;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Services" back={<BackLink href="/home" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <nav aria-label="Your service bookings" className="mb-4 flex gap-2">
          <Link href="/services/bookings" className={linkClass}>
            <Icon name="calendar" className="size-4" />
            My bookings
          </Link>
          {provides && (
            <Link href="/services/jobs" className={linkClass}>
              <Icon name="briefcase" className="size-4" />
              My jobs
            </Link>
          )}
        </nav>
        {/* keyed so a new address (e.g. Back) starts from what the server read */}
        <ServiceDirectory key={canonical} initialQuery={query} initialPage={page} />
      </div>
    </main>
  );
}
