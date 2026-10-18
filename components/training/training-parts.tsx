import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icons";
import { photoUrl } from "@/lib/orders/photos";
import { formatDuration } from "@/lib/training/query";
import {
  categoryLabel,
  difficultyLabel,
  type CourseCard,
  type CourseProgress,
  type Difficulty,
} from "@/lib/training/types";

// Pieces shared by the Korret Academy screens. Every count, duration and
// progress figure shown comes from the server; nothing here calculates one.

export const courseHref = (id: string) => `/training/courses/${encodeURIComponent(id)}`;
export const lessonHref = (courseId: string, lessonId: string) =>
  `${courseHref(courseId)}/lessons/${encodeURIComponent(lessonId)}`;

const DIFFICULTY_TONES: Record<Difficulty, string> = {
  beginner: "bg-accent/12 text-primary",
  intermediate: "bg-amber-50 text-amber-800",
  advanced: "bg-red-50 text-red-700",
};

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${DIFFICULTY_TONES[difficulty]}`}
    >
      {difficultyLabel(difficulty)}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-[0.6875rem] text-foreground/70">
      {children}
    </span>
  );
}

/** The course cover, or a plain placeholder when there isn't one that can be shown. */
export function CourseCover({
  url,
  width,
  className = "",
  priority,
}: {
  url: string | null;
  /** the width to fetch, in pixels (Cloudinary makes the smaller copy) */
  width: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <div aria-hidden="true" className={`relative overflow-hidden bg-primary/8 ${className}`}>
      {url ? (
        <Image
          src={photoUrl(url, width)}
          alt=""
          fill
          sizes={`${width}px`}
          unoptimized
          priority={priority}
          className="object-cover"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-primary">
          <Icon name="graduation-cap" className="size-7" />
        </span>
      )}
    </div>
  );
}

export const lessonsLabel = (n: number) => `${n} ${n === 1 ? "lesson" : "lessons"}`;

export function ProgressBar({ progress, label }: { progress: CourseProgress; label: string }) {
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.completedLessons} of ${progress.totalLessons} lessons complete`}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/8"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${progress.percent}%` }} />
      </div>
      <p className="mt-1 text-[0.6875rem] text-muted-foreground">
        {progress.complete
          ? "Completed"
          : `${progress.completedLessons} of ${progress.totalLessons} lessons · ${progress.percent}%`}
      </p>
    </div>
  );
}

/** One course in a list; the whole card links to its overview. */
export function CourseRow({ course, progress }: { course: CourseCard; progress?: CourseProgress }) {
  return (
    <li>
      <Link
        href={courseHref(course.id)}
        className="flex gap-3 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-foreground/5 outline-none hover:ring-primary/20 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <CourseCover url={course.coverUrl} width={160} className="size-20 shrink-0 rounded-2xl" />
        <div className="min-w-0 flex-1 py-0.5">
          <h3 className="line-clamp-2 text-[0.9375rem] leading-snug font-semibold">{course.title}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{course.instructor}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <DifficultyBadge difficulty={course.difficulty} />
            <Tag>{categoryLabel(course.category)}</Tag>
          </div>
          <p className="mt-1.5 flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
            <Icon name="clock" className="size-3.5" />
            {lessonsLabel(course.lessonCount)} · {formatDuration(course.durationSeconds)}
          </p>
          {progress && (
            <div className="mt-2">
              <ProgressBar progress={progress} label={`Progress in ${course.title}`} />
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

export function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}
