import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, pageHref, pageParam, Pill } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { EmptyList, first, formatDate, Pager } from "@/components/wallet/wallet-parts";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { listCoursesForAdmin } from "@/lib/server/training-admin";
import { categoryLabel, difficultyLabel } from "@/lib/training/types";

export const metadata: Metadata = { title: "Training courses" };

// Korret Academy content: every course, drafts included, most recently
// edited first. Only configured admins get here.
export default async function AdminTrainingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminCapabilityPage("admin.training.manage");
  const page = pageParam(first((await searchParams).page));
  const { courses, hasMore } = await listCoursesForAdmin(page);

  return (
    <main data-wide className="flex flex-1 flex-col">
      <ProfileTopBar title="Training courses" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <Link
          href="/admin/training/new"
          className={buttonClasses("solid", "mb-4 gap-2 lg:w-auto lg:self-start lg:px-6")}
        >
          <Icon name="plus" className="size-4" />
          New course
        </Link>
        {courses.length ? (
          <AdminTable
            label="Courses"
            rows={courses}
            rowKey={(c) => c.id}
            href={(c) => `/admin/training/${c.id}`}
            columns={[
              { header: "Title", cell: (c) => <span className="font-semibold">{c.title}</span> },
              { header: "Topic", cell: (c) => categoryLabel(c.category) },
              { header: "Level", cell: (c) => difficultyLabel(c.difficulty), className: "whitespace-nowrap" },
              { header: "Lessons", cell: (c) => c.lessonCount, className: "text-right tabular-nums" },
              {
                header: "Status",
                cell: (c) => (
                  <span className="flex flex-wrap gap-1">
                    <Pill tone={c.status === "published" ? "good" : "waiting"}>
                      {c.status === "published" ? "Published" : "Draft"}
                    </Pill>
                    {c.featured && <Pill>Featured</Pill>}
                  </span>
                ),
              },
              {
                header: "Edited",
                cell: (c) => formatDate(c.updatedAt, true),
                className: "whitespace-nowrap text-muted-foreground",
              },
            ]}
            card={(c) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{c.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {categoryLabel(c.category)} · {difficultyLabel(c.difficulty)} · {c.lessonCount}{" "}
                    {c.lessonCount === 1 ? "lesson" : "lessons"}
                  </p>
                  <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                    Edited {formatDate(c.updatedAt, true)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Pill tone={c.status === "published" ? "good" : "waiting"}>
                    {c.status === "published" ? "Published" : "Draft"}
                  </Pill>
                  {c.featured && <Pill>Featured</Pill>}
                </div>
              </div>
            )}
          />
        ) : (
          <EmptyList icon="graduation-cap" title={page > 1 ? "No more courses" : "No courses yet"}>
            Create a draft, add its lessons and videos, preview it, then publish it to Korret Academy.
          </EmptyList>
        )}
        <Pager
          newer={page > 1 ? pageHref("/admin/training", {}, page - 1) : null}
          older={hasMore ? pageHref("/admin/training", {}, page + 1) : null}
        />
      </div>
    </main>
  );
}
