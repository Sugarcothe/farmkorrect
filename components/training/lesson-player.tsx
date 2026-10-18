"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { courseHref, lessonHref, ProgressBar } from "@/components/training/training-parts";
import { Button, buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { completeLesson, savePosition } from "@/lib/training/api";
import { formatClock, formatDuration } from "@/lib/training/query";
import type { CourseProgress, LessonView } from "@/lib/training/types";

/** at most one position save per this many ms while playing */
const SAVE_EVERY_MS = 15_000;
/** don't bother saving moves smaller than this */
const MIN_CHANGE_S = 3;
/** resuming this close to the end starts from the beginning instead */
const END_MARGIN_S = 5;

/**
 * The lesson player. The video comes straight from the validated media
 * provider URL the server returned (no embeds, no HTML). The playback
 * position is saved now and then and when the learner pauses or leaves;
 * completion is only shown once the server has recorded it.
 */
export function LessonPlayer({ view }: { view: LessonView }) {
  const { course, lesson } = view;
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSaved = useRef({ at: 0, seconds: lesson.positionSeconds });
  const [videoFailed, setVideoFailed] = useState(false);
  const [completed, setCompleted] = useState(lesson.completed);
  const [progress, setProgress] = useState<CourseProgress>(view.progress);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);

  const save = useCallback(
    async (force: boolean, keepalive = false) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(video.currentTime)) return;
      const seconds = Math.floor(video.currentTime);
      const now = Date.now();
      const { at, seconds: previous } = lastSaved.current;
      if (Math.abs(seconds - previous) < MIN_CHANGE_S) return;
      if (!force && now - at < SAVE_EVERY_MS) return;
      lastSaved.current = { at: now, seconds };
      const result = await savePosition(course.id, lesson.id, seconds, keepalive);
      setSaveError(!result.ok);
    },
    [course.id, lesson.id],
  );

  // leaving the page or switching apps: save where they got to
  useEffect(() => {
    const flush = () => void save(true, true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [save]);

  function resume() {
    const video = videoRef.current;
    if (!video) return;
    const start = lesson.positionSeconds;
    if (start > 0 && (!Number.isFinite(video.duration) || start < video.duration - END_MARGIN_S))
      video.currentTime = start;
  }

  async function markComplete() {
    setCompleting(true);
    setError(null);
    await save(true);
    const result = await completeLesson(course.id, lesson.id);
    setCompleting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCompleted(true);
    setProgress(result.data.progress);
  }

  const showVideo = lesson.videoUrl !== null && !videoFailed;

  return (
    <>
      <div className="overflow-hidden rounded-3xl bg-foreground shadow-sm">
        {showVideo ? (
          <video
            ref={videoRef}
            src={lesson.videoUrl!}
            controls
            playsInline
            preload="metadata"
            controlsList="nodownload"
            onLoadedMetadata={resume}
            onTimeUpdate={() => void save(false)}
            onPause={() => void save(true)}
            onEnded={() => void save(true)}
            onError={() => setVideoFailed(true)}
            className="aspect-video w-full bg-black"
          >
            Your browser can&apos;t play this video.
          </video>
        ) : (
          <div
            role="status"
            className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-foreground/90 px-6 text-center text-white"
          >
            <Icon name="alert-circle" className="size-7" />
            <p className="text-sm font-medium">This video isn&apos;t available right now.</p>
            <p className="text-xs text-white/70">
              {lesson.videoUrl
                ? "It couldn't be loaded. Check your connection and reload."
                : "Please check back later."}
            </p>
          </div>
        )}
      </div>

      {showVideo && lesson.positionSeconds > 0 && !completed && (
        <p className="mt-2 text-xs text-muted-foreground">Resuming from {formatClock(lesson.positionSeconds)}.</p>
      )}
      {saveError && (
        <p className="mt-2 text-xs font-medium text-red-600">
          Your place in this video couldn&apos;t be saved. Check your connection.
        </p>
      )}

      <p className="mt-4 text-xs font-medium text-primary">
        Module {view.module.index + 1}: {view.module.title}
      </p>
      <h1 className="mt-1 text-xl leading-snug font-semibold tracking-tight">{lesson.title}</h1>
      <p className="mt-1 text-xs text-muted-foreground">{formatDuration(lesson.durationSeconds)}</p>
      {lesson.summary && (
        <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-foreground/80">{lesson.summary}</p>
      )}

      {lesson.resources.length > 0 && (
        <section aria-labelledby="resources-heading" className="mt-5">
          <h2 id="resources-heading" className="mb-2 text-sm font-semibold">
            Resources
          </h2>
          <ul className="divide-y divide-foreground/6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
            {lesson.resources.map((r) => (
              <li key={r.id}>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium outline-none first:rounded-t-3xl last:rounded-b-3xl hover:bg-primary/3 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Icon name="file-text" className="size-5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="text-xs text-muted-foreground">PDF</span>
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-5 space-y-3" aria-live="polite">
        {error && <FormAlert>{error}</FormAlert>}
        {completed ? (
          <FormAlert tone="success">Lesson complete.</FormAlert>
        ) : (
          <Button type="button" loading={completing} onClick={markComplete}>
            {completing ? "Saving…" : "Mark lesson complete"}
          </Button>
        )}
        <div className="rounded-2xl bg-white px-4 py-3 ring-1 ring-foreground/5">
          <ProgressBar progress={progress} label={`Your progress in ${course.title}`} />
        </div>
      </div>

      <nav aria-label="Lessons" className="mt-4 grid grid-cols-2 gap-2">
        {view.previousLessonId ? (
          <Link
            href={lessonHref(course.id, view.previousLessonId)}
            className={buttonClasses("outline", "h-11 text-sm")}
          >
            <Icon name="arrow-left" className="mr-1.5 size-4" />
            Previous
          </Link>
        ) : (
          <span />
        )}
        {view.nextLessonId ? (
          <Link
            href={lessonHref(course.id, view.nextLessonId)}
            className={buttonClasses(completed ? "solid" : "outline", "h-11 text-sm")}
          >
            Next lesson
            <Icon name="chevron-right" className="ml-1.5 size-4" />
          </Link>
        ) : (
          <Link href={courseHref(course.id)} className={buttonClasses("outline", "h-11 text-sm")}>
            Course overview
          </Link>
        )}
      </nav>

      <details className="mt-6 rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
        <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-accent">
          All lessons
          <Icon name="chevron-down" className="size-4" />
        </summary>
        <ol className="border-t border-foreground/6 pb-2">
          {view.modules.map((module, m) => (
            <li key={module.id} className="px-4 pt-3">
              <p className="text-xs font-semibold text-foreground/60">
                Module {m + 1}: {module.title}
              </p>
              <ol className="mt-1">
                {module.lessons.map((l) => {
                  const done = l.id === lesson.id ? completed : l.completed;
                  return (
                    <li key={l.id}>
                      <Link
                        href={lessonHref(course.id, l.id)}
                        aria-current={l.id === lesson.id ? "page" : undefined}
                        className={`flex items-center gap-2 rounded-xl px-2 py-2 text-sm outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent ${
                          l.id === lesson.id ? "bg-primary/5 font-semibold text-primary" : ""
                        }`}
                      >
                        <Icon
                          name={done ? "check-circle" : "play"}
                          className={`size-4 shrink-0 ${done ? "text-accent" : "text-foreground/40"}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{l.title}</span>
                        <span className="text-[0.6875rem] text-muted-foreground">
                          {formatDuration(l.durationSeconds)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}
