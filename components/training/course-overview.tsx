import Link from "next/link";
import type { ReactNode } from "react";
import {
  CourseCover,
  DifficultyBadge,
  lessonHref,
  lessonsLabel,
  ProgressBar,
  Tag,
} from "@/components/training/training-parts";
import { Icon } from "@/components/ui/icons";
import { formatDuration } from "@/lib/training/query";
import { categoryLabel, type CourseDetail } from "@/lib/training/types";

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed">
          <Icon name="check-circle" className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A course's overview: cover, details, objectives and its ordered curriculum
 * with this learner's completion state. `action` is the Start/Resume control;
 * `linkLessons` is off in the admin preview, where lessons aren't playable.
 */
export function CourseOverview({
  course,
  action,
  linkLessons = true,
}: {
  course: CourseDetail;
  action: ReactNode;
  linkLessons?: boolean;
}) {
  return (
    <>
      <CourseCover url={course.coverUrl} width={720} priority className="aspect-video w-full rounded-3xl" />
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <DifficultyBadge difficulty={course.difficulty} />
        <Tag>{categoryLabel(course.category)}</Tag>
      </div>
      <h1 className="mt-2 text-xl leading-snug font-semibold tracking-tight">{course.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">By {course.instructor}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-white px-3 py-2.5 ring-1 ring-foreground/5">
          <dt className="text-[0.6875rem] text-muted-foreground">Lessons</dt>
          <dd className="text-sm font-semibold">{course.lessonCount}</dd>
        </div>
        <div className="rounded-2xl bg-white px-3 py-2.5 ring-1 ring-foreground/5">
          <dt className="text-[0.6875rem] text-muted-foreground">Total duration</dt>
          <dd className="text-sm font-semibold">{formatDuration(course.durationSeconds)}</dd>
        </div>
      </dl>

      {course.enrolled && (
        <div className="mt-4 rounded-2xl bg-white px-4 py-3 ring-1 ring-foreground/5">
          <ProgressBar progress={course.progress} label="Your progress in this course" />
        </div>
      )}

      <div className="mt-4">{action}</div>

      <section aria-labelledby="about-heading" className="mt-6">
        <h2 id="about-heading" className="mb-2 text-base font-semibold">
          About this course
        </h2>
        <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/80">{course.description}</p>
      </section>

      {course.objectives.length > 0 && (
        <section aria-labelledby="objectives-heading" className="mt-6">
          <h2 id="objectives-heading" className="mb-2 text-base font-semibold">
            What you&apos;ll learn
          </h2>
          <BulletList items={course.objectives} />
        </section>
      )}

      {course.prerequisites.length > 0 && (
        <section aria-labelledby="prerequisites-heading" className="mt-6">
          <h2 id="prerequisites-heading" className="mb-2 text-base font-semibold">
            Before you start
          </h2>
          <BulletList items={course.prerequisites} />
        </section>
      )}

      <section aria-labelledby="curriculum-heading" className="mt-6">
        <h2 id="curriculum-heading" className="mb-3 text-base font-semibold">
          Curriculum
        </h2>
        <ol className="space-y-4">
          {course.modules.map((module, m) => (
            <li key={module.id}>
              <h3 className="mb-2 text-sm font-semibold text-foreground/80">
                Module {m + 1}: {module.title}
              </h3>
              <ol className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
                {module.lessons.map((lesson, l) => {
                  const body = (
                    <>
                      <span
                        className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                          lesson.completed ? "bg-accent/15 text-primary" : "bg-foreground/5 text-foreground/55"
                        }`}
                      >
                        <Icon name={lesson.completed ? "check" : "play"} className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {l + 1}. {lesson.title}
                        </span>
                        <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
                          {formatDuration(lesson.durationSeconds)}
                          {lesson.resourceCount > 0 &&
                            ` · ${lesson.resourceCount} ${lesson.resourceCount === 1 ? "PDF" : "PDFs"}`}
                          {!lesson.hasVideo && " · Video unavailable"}
                          {lesson.completed && " · Completed"}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li key={lesson.id}>
                      {linkLessons ? (
                        <Link
                          href={lessonHref(course.id, lesson.id)}
                          className="flex items-center gap-3 px-4 py-3 outline-none first:rounded-t-3xl last:rounded-b-3xl hover:bg-primary/3 focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="flex items-center gap-3 px-4 py-3">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted-foreground">{lessonsLabel(course.lessonCount)} in total.</p>
      </section>
    </>
  );
}
