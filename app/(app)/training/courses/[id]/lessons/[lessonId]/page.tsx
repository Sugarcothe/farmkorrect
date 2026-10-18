import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { LessonPlayer } from "@/components/training/lesson-player";
import { courseHref } from "@/components/training/training-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getLessonView } from "@/lib/server/training";

export const metadata: Metadata = { title: "Lesson" };

// One lesson of a published course, with the learner's saved position.
// A lesson that isn't in the course's published curriculum is a 404.
export default async function LessonPage({ params }: { params: Promise<{ id: string; lessonId: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const { id, lessonId } = await params;
  const view = await getLessonView(user._id, id, lessonId);
  if (!view) notFound();

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={view.course.title} back={<BackLink href={courseHref(view.course.id)} />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        {/* keyed so moving to another lesson starts a fresh player */}
        <LessonPlayer key={view.lesson.id} view={view} />
      </div>
    </main>
  );
}
