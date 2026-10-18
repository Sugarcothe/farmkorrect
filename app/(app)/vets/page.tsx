import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { VetDirectory } from "@/components/vets/vet-directory";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { searchDirectory } from "@/lib/server/vet-directory";
import { parseDirectoryQuery, queryParams } from "@/lib/vets/query";
import { DIRECTORY_PAGE_SIZE, type DirectoryPage, type DirectoryQuery } from "@/lib/vets/types";

export const metadata: Metadata = { title: "Find a Vet" };

type RawParams = Record<string, string | string[] | undefined>;

async function firstPage(query: DirectoryQuery): Promise<DirectoryPage | null> {
  try {
    return await searchDirectory(query, null, DIRECTORY_PAGE_SIZE);
  } catch (error) {
    console.error(`[vets] directory search failed: ${error instanceof Error ? error.name : typeof error}`);
    return null;
  }
}

// Find a Vet: veterinarians whose credentials the Farm Korret team has
// reviewed and who have listed themselves with bookable services. The
// filters are in the address; the first page is read here, later pages by
// the browser through /api/vets (see docs/find-vet.md).
export default async function VetsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireVerifiedPageSession();
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw))
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  const { query } = parseDirectoryQuery(params);
  // unknown or invalid values: show the address that matches what's on screen
  const canonical = queryParams(query).toString();
  if (canonical !== params.toString()) redirect(canonical ? `/vets?${canonical}` : "/vets");

  const page = await firstPage(query);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Find a Vet" back={<BackLink href="/home" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <nav aria-label="Your appointments" className="mb-4">
          <Link
            href="/appointments"
            className="flex items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2.5 text-[0.8125rem] font-medium text-primary ring-1 ring-foreground/8 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="calendar" className="size-4" />
            My appointments
          </Link>
        </nav>
        {/* keyed so a new address (e.g. Back) starts from what the server read */}
        <VetDirectory key={canonical} initialQuery={query} initialPage={page} />
      </div>
    </main>
  );
}
