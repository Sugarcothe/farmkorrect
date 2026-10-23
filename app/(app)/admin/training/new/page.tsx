import type { Metadata } from "next";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { CourseEditor } from "@/components/training/course-editor";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { isMediaConfigured } from "@/lib/server/training-media";

export const metadata: Metadata = { title: "New course" };

// A new course is always saved as a private draft first.
export default async function NewCoursePage() {
  await requireAdminCapabilityPage("admin.training.manage");
  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="New course" back={<BackLink href="/admin/training" />} />
      <div className="flex flex-1 flex-col px-5">
        <CourseEditor initial={null} mediaConfigured={isMediaConfigured()} />
      </div>
    </main>
  );
}
