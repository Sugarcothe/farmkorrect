import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { InvitationList } from "@/components/training/invitation-list";
import { CourseRow, SectionHeading } from "@/components/training/training-parts";
import { Icon } from "@/components/ui/icons";
import { EmptyList } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { HttpError } from "@/lib/server/http";
import { getTrainingHome, searchCatalog } from "@/lib/server/training";
import { findOwnFarm, listInvitations, myAssignments } from "@/lib/server/training-staff";
import { catalogParams, hasCatalogFilters, parseCatalogQuery } from "@/lib/training/query";
import {
  CATALOG_PAGE_SIZE,
  COURSE_CATEGORIES,
  DIFFICULTIES,
  staffRoleSingle,
  type CatalogQuery,
} from "@/lib/training/types";

export const metadata: Metadata = { title: "Korret Academy" };

type RawParams = Record<string, string | string[] | undefined>;

const selectClass =
  "h-11 w-full min-w-0 cursor-pointer appearance-none rounded-full bg-white px-4 text-sm ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-accent";

function SearchForm({ query }: { query: CatalogQuery }) {
  return (
    <form role="search" action="/training" method="get" className="mb-6 space-y-2.5">
      <label htmlFor="training-q" className="sr-only">
        Search courses
      </label>
      <div className="flex h-12 items-center gap-2.5 rounded-full bg-white px-4 shadow-sm ring-1 ring-foreground/8 focus-within:ring-2 focus-within:ring-accent">
        <Icon name="search" className="size-[18px] shrink-0 text-foreground/40" />
        <input
          id="training-q"
          name="q"
          type="search"
          defaultValue={query.q}
          maxLength={60}
          placeholder="Search by title, topic or instructor"
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-foreground/40"
        />
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <label className="sr-only" htmlFor="training-category">
          Category
        </label>
        <select id="training-category" name="category" defaultValue={query.category ?? ""} className={selectClass}>
          <option value="">All topics</option>
          {COURSE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="training-difficulty">
          Difficulty
        </label>
        <select
          id="training-difficulty"
          name="difficulty"
          defaultValue={query.difficulty ?? ""}
          className={selectClass}
        >
          <option value="">All levels</option>
          {DIFFICULTIES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="h-11 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary-dark focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          Search
        </button>
      </div>
      {hasCatalogFilters(query) && (
        <Link href="/training" className="inline-block px-1 text-xs font-medium text-primary hover:underline">
          Clear search and filters
        </Link>
      )}
    </form>
  );
}

// Korret Academy. The search and filters are a plain form whose values live
// in the address, so Back and reloads keep them; pages after the first carry
// a signed cursor tied to that exact search (see docs/training-academy.md).
export default async function TrainingPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const { user } = await requireVerifiedPageSession();
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw))
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  const { query } = parseCatalogQuery(params);
  const cursor = params.get("cursor");
  const canonical = catalogParams(query);
  const base = canonical.toString();
  // unknown values or a stray parameter: show the address that matches what's on screen
  const expected = new URLSearchParams(canonical);
  if (cursor) expected.set("cursor", cursor);
  if (expected.toString() !== params.toString()) redirect(base ? `/training?${base}` : "/training");

  const firstPage = !cursor && !hasCatalogFilters(query);
  let catalog;
  try {
    catalog = await searchCatalog(query, cursor, CATALOG_PAGE_SIZE);
  } catch (error) {
    // a cursor from an older list or another search: start that search again
    if (error instanceof HttpError && error.status === 400) redirect(base ? `/training?${base}` : "/training");
    throw error;
  }
  const [home, invitations, assignments, farm] = await Promise.all([
    firstPage ? getTrainingHome(user._id) : null,
    firstPage ? listInvitations(user) : [],
    firstPage ? myAssignments(user) : [],
    findOwnFarm(user),
  ]);

  const nextHref = catalog.nextCursor
    ? `/training?${new URLSearchParams([...canonical, ["cursor", catalog.nextCursor]])}`
    : null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Korret Academy" back={<BackLink href="/home" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        {farm && (
          <nav aria-label="Staff training" className="mb-4">
            <Link
              href="/training/staff"
              className="flex items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2.5 text-[0.8125rem] font-medium text-primary ring-1 ring-foreground/8 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon name="users" className="size-4" />
              Staff Training Programs
            </Link>
          </nav>
        )}

        <InvitationList invitations={invitations} />

        {assignments.map((a) => (
          <section key={a.membershipId} aria-labelledby={`assigned-${a.membershipId}`} className="mb-6">
            <SectionHeading>
              <span id={`assigned-${a.membershipId}`}>Assigned by {a.farmName}</span>
            </SectionHeading>
            <p className="-mt-2 mb-3 text-xs text-muted-foreground">{staffRoleSingle(a.role)} programme</p>
            {a.courses.length === 0 ? (
              <p className="rounded-2xl bg-white px-4 py-3 text-sm text-muted-foreground ring-1 ring-foreground/5">
                No courses have been assigned to your role yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {a.courses.map((item) => (
                  <CourseRow key={item.id} course={item} progress={item.progress} />
                ))}
              </ul>
            )}
          </section>
        ))}

        {home && home.continueLearning.length > 0 && (
          <section aria-labelledby="continue-heading" className="mb-6">
            <SectionHeading>
              <span id="continue-heading">Continue learning</span>
            </SectionHeading>
            <ul className="space-y-3">
              {home.continueLearning.map((item) => (
                <CourseRow key={item.id} course={item} progress={item.progress} />
              ))}
            </ul>
          </section>
        )}

        {home && home.featured.length > 0 && (
          <section aria-labelledby="featured-heading" className="mb-6">
            <SectionHeading>
              <span id="featured-heading">Featured courses</span>
            </SectionHeading>
            <ul className="space-y-3">
              {home.featured.map((course) => (
                <CourseRow key={course.id} course={course} />
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="catalog-heading">
          <SectionHeading>
            <span id="catalog-heading">{hasCatalogFilters(query) ? "Search results" : "All courses"}</span>
          </SectionHeading>
          <SearchForm query={query} />
          {catalog.courses.length === 0 ? (
            hasCatalogFilters(query) ? (
              <EmptyList icon="search" title="No courses match">
                Try other words, or clear the topic and level filters.
              </EmptyList>
            ) : cursor ? (
              <EmptyList icon="book" title="That's every course">
                There are no more courses in this list.
              </EmptyList>
            ) : (
              <EmptyList icon="graduation-cap" title="No courses yet">
                Courses will appear here once the Farm Korret team publishes them.
              </EmptyList>
            )
          ) : (
            <ul aria-label="Courses" className="space-y-3">
              {catalog.courses.map((course) => (
                <CourseRow key={course.id} course={course} />
              ))}
            </ul>
          )}
          {(cursor || nextHref) && (
            <nav aria-label="Pages" className="mt-4 flex justify-between">
              {cursor ? (
                <Link
                  href={base ? `/training?${base}` : "/training"}
                  className="flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Icon name="arrow-left" className="size-4" />
                  First page
                </Link>
              ) : (
                <span />
              )}
              {nextHref && (
                <Link
                  href={nextHref}
                  className="flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  More courses
                  <Icon name="chevron-right" className="size-4" />
                </Link>
              )}
            </nav>
          )}
        </section>
      </div>
    </main>
  );
}
