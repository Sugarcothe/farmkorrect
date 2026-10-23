import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { CourseOverview } from "@/components/training/course-overview";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { buildCourseDetail } from "@/lib/server/training";
import { findCourseForAdmin } from "@/lib/server/training-admin";

export const metadata: Metadata = { title: "Course preview" };

// What learners will see on the course page, for any course including
// drafts. Admins only; nothing is enrolled or recorded.
export default async function CoursePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminCapabilityPage("admin.training.manage");
  const doc = await findCourseForAdmin((await params).id);
  if (!doc) notFound();
  const course = buildCourseDetail(doc, new Set(), null);
  const id = doc._id.toHexString();

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Course preview" back={<BackLink href={`/admin/training/${id}`} />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <div
          role="note"
          className="mb-4 flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900"
        >
          <Icon name="eye" className="mt-px size-[18px] shrink-0" />
          <p>
            {doc.status === "draft"
              ? "Preview of a draft. Learners can't see this course until it's published."
              : "Preview of a published course, as learners see it before they start."}
          </p>
        </div>
        <CourseOverview
          course={course}
          linkLessons={false}
          action={
            <Link href={`/admin/training/${id}`} className={buttonClasses("outline")}>
              Back to editing
            </Link>
          }
        />
      </div>
    </main>
  );
}
