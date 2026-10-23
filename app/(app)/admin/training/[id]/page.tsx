import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { CourseEditor } from "@/components/training/course-editor";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { findCourseForAdmin, toAdminCourse } from "@/lib/server/training-admin";
import { isMediaConfigured } from "@/lib/server/training-media";

export const metadata: Metadata = { title: "Edit course" };

// Edit a course, preview it, and publish or unpublish it. Every change is
// validated and audited on the server.
export default async function EditCoursePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminCapabilityPage("admin.training.manage");
  const doc = await findCourseForAdmin((await params).id);
  if (!doc) notFound();
  const course = toAdminCourse(doc);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Edit course" back={<BackLink href="/admin/training" />} />
      <div className="flex flex-1 flex-col px-5">
        {/* keyed so a newer saved version (e.g. after a refresh) starts a fresh form */}
        <CourseEditor key={course.updatedAt} initial={course} mediaConfigured={isMediaConfigured()} />
      </div>
    </main>
  );
}
