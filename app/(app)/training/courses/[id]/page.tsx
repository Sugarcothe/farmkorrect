import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { CourseOverview } from "@/components/training/course-overview";
import { StartCourseButton } from "@/components/training/start-course-button";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getCourseDetail } from "@/lib/server/training";

export const metadata: Metadata = { title: "Course Overview" };

// A published course and the signed-in learner's own progress through it.
// Drafts, unpublished courses and unknown ids all get the same 404.
export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const course = await getCourseDetail(user._id, (await params).id);
  if (!course) notFound();

  const label = course.progress.complete
    ? "Review course"
    : course.enrolled && course.progress.completedLessons > 0
      ? "Resume course"
      : course.enrolled
        ? "Continue course"
        : "Start course";

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Course Overview" back={<BackLink href="/training" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <CourseOverview
          course={course}
          action={
            course.lessonCount > 0 ? (
              <StartCourseButton courseId={course.id} label={label} />
            ) : (
              <p className="text-sm text-muted-foreground">This course has no lessons yet.</p>
            )
          }
        />
      </div>
    </main>
  );
}
