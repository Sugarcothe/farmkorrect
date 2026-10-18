"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { changeCourseStatus, createCourse, updateCourse } from "@/lib/training/api";
import {
  COURSE_CATEGORIES,
  DIFFICULTIES,
  TRAINING_LIMITS,
  type AdminCourse,
  type CourseCategory,
  type CourseInput,
  type Difficulty,
} from "@/lib/training/types";

// The admin course form. Ids of modules, lessons and resources are only ever
// ones the server issued: new items are sent without one, and after every
// save the form is rebuilt from the saved course so later saves keep them
// (learners' progress is recorded against lesson ids).

type ResourceDraft = { key: string; id?: string; title: string; url: string };
type LessonDraft = {
  key: string;
  id?: string;
  title: string;
  summary: string;
  minutes: string;
  videoUrl: string;
  resources: ResourceDraft[];
};
type ModuleDraft = { key: string; id?: string; title: string; lessons: LessonDraft[] };
type Draft = {
  title: string;
  description: string;
  instructor: string;
  category: CourseCategory | "";
  difficulty: Difficulty | "";
  objectives: string;
  prerequisites: string;
  coverUrl: string;
  featured: boolean;
  modules: ModuleDraft[];
};

let counter = 0;
const key = () => `k${++counter}`;

const emptyLesson = (): LessonDraft => ({
  key: key(),
  title: "",
  summary: "",
  minutes: "",
  videoUrl: "",
  resources: [],
});
const emptyModule = (): ModuleDraft => ({ key: key(), title: "", lessons: [emptyLesson()] });

function toDraft(course: AdminCourse | null): Draft {
  if (!course)
    return {
      title: "",
      description: "",
      instructor: "",
      category: "",
      difficulty: "",
      objectives: "",
      prerequisites: "",
      coverUrl: "",
      featured: false,
      modules: [emptyModule()],
    };
  return {
    title: course.title,
    description: course.description,
    instructor: course.instructor,
    category: course.category,
    difficulty: course.difficulty,
    objectives: course.objectives.join("\n"),
    prerequisites: course.prerequisites.join("\n"),
    coverUrl: course.coverUrl ?? "",
    featured: course.featured,
    modules: course.modules.map((m) => ({
      key: m.id,
      id: m.id,
      title: m.title,
      lessons: m.lessons.map((l) => ({
        key: l.id,
        id: l.id,
        title: l.title,
        summary: l.summary,
        minutes: String(l.durationMinutes),
        videoUrl: l.videoUrl ?? "",
        resources: l.resources.map((r) => ({ key: r.id, id: r.id, title: r.title, url: r.url })),
      })),
    })),
  };
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

function toInput(draft: Draft, updatedAt: string | undefined): CourseInput {
  return {
    title: draft.title,
    description: draft.description,
    instructor: draft.instructor,
    category: draft.category,
    difficulty: draft.difficulty,
    objectives: lines(draft.objectives),
    prerequisites: lines(draft.prerequisites),
    coverUrl: draft.coverUrl.trim(),
    featured: draft.featured,
    modules: draft.modules.map((m) => ({
      ...(m.id ? { id: m.id } : {}),
      title: m.title,
      lessons: m.lessons.map((l) => ({
        ...(l.id ? { id: l.id } : {}),
        title: l.title,
        summary: l.summary,
        durationMinutes: /^\d+$/.test(l.minutes.trim()) ? Number(l.minutes.trim()) : NaN,
        videoUrl: l.videoUrl.trim(),
        resources: l.resources.map((r) => ({ ...(r.id ? { id: r.id } : {}), title: r.title, url: r.url.trim() })),
      })),
    })),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function IconButton({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: "trash" | "chevron-down" | "arrow-left";
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30 ${
        danger ? "text-red-600 hover:bg-red-50" : "text-foreground/55 hover:bg-foreground/5"
      }`}
    >
      <Icon name={icon} className={`size-4 ${icon === "arrow-left" ? "rotate-90" : ""}`} />
    </button>
  );
}

function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

function StatusControls({ course, onChanged }: { course: AdminCourse; onChanged: (course: AdminCourse) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publishing = course.status === "draft";

  async function change() {
    setBusy(true);
    setError(null);
    const result = await changeCourseStatus(course.id, {
      action: publishing ? "publish" : "unpublish",
      updatedAt: course.updatedAt,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onChanged(result.data.course);
  }

  return (
    <section
      aria-labelledby="status-heading"
      className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="status-heading" className="text-base font-semibold">
          {publishing ? "Draft" : "Published"}
        </h2>
        <Link
          href={`/admin/training/${course.id}/preview`}
          className="text-sm font-medium text-primary hover:underline"
        >
          Preview
        </Link>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {publishing
          ? "Only admins can see this course. Publishing shows it in Korret Academy to every signed-in user."
          : "Learners can see and take this course. Unpublishing hides it again; their progress is kept."}
      </p>
      {publishing && course.publishIssues.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
          {course.publishIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {error && <FormAlert>{error}</FormAlert>}
      <Button
        type="button"
        variant={publishing ? "solid" : "outline"}
        loading={busy}
        disabled={publishing && course.publishIssues.length > 0}
        onClick={change}
      >
        {publishing ? "Publish course" : "Unpublish course"}
      </Button>
      <p className="text-[0.6875rem] text-muted-foreground">Save any changes above before publishing.</p>
    </section>
  );
}

export function CourseEditor({ initial, mediaConfigured }: { initial: AdminCourse | null; mediaConfigured: boolean }) {
  const router = useRouter();
  const [course, setCourse] = useState<AdminCourse | null>(initial);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((d) => ({ ...d, [field]: value }));
  const setModule = (mi: number, change: (m: ModuleDraft) => ModuleDraft) =>
    setDraft((d) => ({ ...d, modules: d.modules.map((m, i) => (i === mi ? change(m) : m)) }));
  const setLesson = (mi: number, li: number, change: (l: LessonDraft) => LessonDraft) =>
    setModule(mi, (m) => ({ ...m, lessons: m.lessons.map((l, i) => (i === li ? change(l) : l)) }));

  function adopt(saved: AdminCourse, message: string) {
    setCourse(saved);
    setDraft(toDraft(saved));
    setErrors({});
    setNotice(message);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const input = toInput(draft, course?.updatedAt);
    const result = course ? await updateCourse(course.id, input) : await createCourse(input);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      setErrors(result.fieldErrors ?? {});
      return;
    }
    if (!course) {
      router.replace(`/admin/training/${result.data.course.id}`);
      return;
    }
    adopt(result.data.course, "Course saved.");
  }

  const lessonTotal = draft.modules.reduce((n, m) => n + m.lessons.length, 0);

  return (
    <div className="space-y-6">
      {course && (
        <StatusControls
          course={course}
          onChanged={(c) => adopt(c, c.status === "published" ? "Course published." : "Course unpublished.")}
        />
      )}

      <form onSubmit={submit} noValidate className="space-y-6">
        <div aria-live="polite" className="space-y-2">
          {notice && <FormAlert tone="success">{notice}</FormAlert>}
          {error && <FormAlert>{error}</FormAlert>}
        </div>
        {!mediaConfigured && (
          <FormAlert>
            Media storage (Cloudinary) isn&apos;t configured on this server, so covers, videos and PDFs can&apos;t be
            added yet. Drafts can still be saved without them.
          </FormAlert>
        )}

        <section aria-labelledby="details-heading" className="space-y-4">
          <h2 id="details-heading" className="text-base font-semibold">
            Details
          </h2>
          <TextField
            name="title"
            label="Title"
            value={draft.title}
            maxLength={TRAINING_LIMITS.title.max}
            onChange={(e) => set("title", e.target.value)}
            error={errors.title}
            required
          />
          <TextAreaField
            name="description"
            label="Description"
            value={draft.description}
            maxLength={TRAINING_LIMITS.description.max}
            onChange={(e) => set("description", e.target.value)}
            error={errors.description}
            required
          />
          <TextField
            name="instructor"
            label="Instructor"
            hint="The real person or organisation teaching this course."
            value={draft.instructor}
            maxLength={TRAINING_LIMITS.instructor.max}
            onChange={(e) => set("instructor", e.target.value)}
            error={errors.instructor}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              name="category"
              label="Category"
              placeholder="Choose"
              options={COURSE_CATEGORIES}
              value={draft.category}
              onChange={(e) => set("category", e.target.value as CourseCategory)}
              error={errors.category}
            />
            <SelectField
              name="difficulty"
              label="Difficulty"
              placeholder="Choose"
              options={DIFFICULTIES}
              value={draft.difficulty}
              onChange={(e) => set("difficulty", e.target.value as Difficulty)}
              error={errors.difficulty}
            />
          </div>
          <TextAreaField
            name="objectives"
            label="What learners will learn"
            hint={`One per line, up to ${TRAINING_LIMITS.listItems}.`}
            value={draft.objectives}
            onChange={(e) => set("objectives", e.target.value)}
            error={errors.objectives}
          />
          <TextAreaField
            name="prerequisites"
            label="Prerequisites"
            hint={`Optional. One per line, up to ${TRAINING_LIMITS.listItems}.`}
            value={draft.prerequisites}
            onChange={(e) => set("prerequisites", e.target.value)}
            error={errors.prerequisites}
          />
          <TextField
            name="coverUrl"
            label="Cover image URL"
            hint="Optional. A Cloudinary image URL (JPG, PNG or WebP) from this app's account."
            type="url"
            inputMode="url"
            value={draft.coverUrl}
            maxLength={TRAINING_LIMITS.mediaUrl}
            onChange={(e) => set("coverUrl", e.target.value)}
            error={errors.coverUrl}
          />
          <Switch
            label="Featured"
            description="Featured published courses are shown at the top of Korret Academy (newest first, up to 6)."
            checked={draft.featured}
            onChange={(v) => set("featured", v)}
          />
        </section>

        <section aria-labelledby="curriculum-heading" className="space-y-4">
          <div>
            <h2 id="curriculum-heading" className="text-base font-semibold">
              Curriculum
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {draft.modules.length} {draft.modules.length === 1 ? "module" : "modules"} · {lessonTotal}{" "}
              {lessonTotal === 1 ? "lesson" : "lessons"}. Videos are Cloudinary MP4 or WebM URLs; upload them in
              Cloudinary first (see docs/training-academy.md).
            </p>
            {errors.modules && <p className="mt-1 text-xs font-medium text-red-600">{errors.modules}</p>}
          </div>

          {draft.modules.map((module, mi) => {
            const mk = `modules.${mi}`;
            return (
              <Panel
                key={module.key}
                title={`Module ${mi + 1}${module.title ? `: ${module.title}` : ""}`}
                actions={
                  <>
                    <IconButton
                      label="Move module up"
                      icon="arrow-left"
                      disabled={mi === 0}
                      onClick={() => setDraft((d) => ({ ...d, modules: move(d.modules, mi, mi - 1) }))}
                    />
                    <IconButton
                      label="Move module down"
                      icon="chevron-down"
                      disabled={mi === draft.modules.length - 1}
                      onClick={() => setDraft((d) => ({ ...d, modules: move(d.modules, mi, mi + 1) }))}
                    />
                    <IconButton
                      label="Remove module"
                      icon="trash"
                      danger
                      onClick={() => setDraft((d) => ({ ...d, modules: d.modules.filter((_, i) => i !== mi) }))}
                    />
                  </>
                }
              >
                {errors[`${mk}.id`] && <p className="text-xs font-medium text-red-600">{errors[`${mk}.id`]}</p>}
                <TextField
                  name={`${mk}.title`}
                  label="Module title"
                  value={module.title}
                  maxLength={TRAINING_LIMITS.moduleTitle.max}
                  onChange={(e) => setModule(mi, (m) => ({ ...m, title: e.target.value }))}
                  error={errors[`${mk}.title`]}
                />
                {errors[`${mk}.lessons`] && (
                  <p className="text-xs font-medium text-red-600">{errors[`${mk}.lessons`]}</p>
                )}
                <ol className="space-y-3">
                  {module.lessons.map((lesson, li) => {
                    const lk = `${mk}.lessons.${li}`;
                    return (
                      <li key={lesson.key} className="space-y-3 rounded-2xl bg-foreground/3 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-foreground/70">Lesson {li + 1}</p>
                          <div className="flex items-center">
                            <IconButton
                              label="Move lesson up"
                              icon="arrow-left"
                              disabled={li === 0}
                              onClick={() => setModule(mi, (m) => ({ ...m, lessons: move(m.lessons, li, li - 1) }))}
                            />
                            <IconButton
                              label="Move lesson down"
                              icon="chevron-down"
                              disabled={li === module.lessons.length - 1}
                              onClick={() => setModule(mi, (m) => ({ ...m, lessons: move(m.lessons, li, li + 1) }))}
                            />
                            <IconButton
                              label="Remove lesson"
                              icon="trash"
                              danger
                              onClick={() =>
                                setModule(mi, (m) => ({ ...m, lessons: m.lessons.filter((_, i) => i !== li) }))
                              }
                            />
                          </div>
                        </div>
                        {errors[`${lk}.id`] && <p className="text-xs font-medium text-red-600">{errors[`${lk}.id`]}</p>}
                        <TextField
                          name={`${lk}.title`}
                          label="Lesson title"
                          value={lesson.title}
                          maxLength={TRAINING_LIMITS.lessonTitle.max}
                          onChange={(e) => setLesson(mi, li, (l) => ({ ...l, title: e.target.value }))}
                          error={errors[`${lk}.title`]}
                        />
                        <TextField
                          name={`${lk}.durationMinutes`}
                          label="Duration (minutes)"
                          inputMode="numeric"
                          value={lesson.minutes}
                          onChange={(e) => setLesson(mi, li, (l) => ({ ...l, minutes: e.target.value }))}
                          error={errors[`${lk}.durationMinutes`]}
                        />
                        <TextField
                          name={`${lk}.videoUrl`}
                          label="Video URL"
                          type="url"
                          inputMode="url"
                          hint="Required before publishing."
                          value={lesson.videoUrl}
                          maxLength={TRAINING_LIMITS.mediaUrl}
                          onChange={(e) => setLesson(mi, li, (l) => ({ ...l, videoUrl: e.target.value }))}
                          error={errors[`${lk}.videoUrl`]}
                        />
                        <TextAreaField
                          name={`${lk}.summary`}
                          label="Summary"
                          hint="Optional."
                          value={lesson.summary}
                          maxLength={TRAINING_LIMITS.lessonSummary}
                          onChange={(e) => setLesson(mi, li, (l) => ({ ...l, summary: e.target.value }))}
                          error={errors[`${lk}.summary`]}
                        />
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-foreground/70">PDF resources</p>
                          {errors[`${lk}.resources`] && (
                            <p className="text-xs font-medium text-red-600">{errors[`${lk}.resources`]}</p>
                          )}
                          {lesson.resources.map((resource, ri) => {
                            const rk = `${lk}.resources.${ri}`;
                            const setResource = (change: Partial<ResourceDraft>) =>
                              setLesson(mi, li, (l) => ({
                                ...l,
                                resources: l.resources.map((r, i) => (i === ri ? { ...r, ...change } : r)),
                              }));
                            return (
                              <div key={resource.key} className="space-y-2 rounded-xl bg-white p-2.5">
                                <div className="flex items-center justify-between">
                                  <p className="text-[0.6875rem] font-semibold text-foreground/60">PDF {ri + 1}</p>
                                  <IconButton
                                    label="Remove PDF"
                                    icon="trash"
                                    danger
                                    onClick={() =>
                                      setLesson(mi, li, (l) => ({
                                        ...l,
                                        resources: l.resources.filter((_, i) => i !== ri),
                                      }))
                                    }
                                  />
                                </div>
                                {errors[`${rk}.id`] && (
                                  <p className="text-xs font-medium text-red-600">{errors[`${rk}.id`]}</p>
                                )}
                                <TextField
                                  name={`${rk}.title`}
                                  label="Title"
                                  value={resource.title}
                                  maxLength={TRAINING_LIMITS.resourceTitle.max}
                                  onChange={(e) => setResource({ title: e.target.value })}
                                  error={errors[`${rk}.title`]}
                                />
                                <TextField
                                  name={`${rk}.url`}
                                  label="PDF URL"
                                  type="url"
                                  inputMode="url"
                                  value={resource.url}
                                  maxLength={TRAINING_LIMITS.mediaUrl}
                                  onChange={(e) => setResource({ url: e.target.value })}
                                  error={errors[`${rk}.url`]}
                                />
                              </div>
                            );
                          })}
                          {lesson.resources.length < TRAINING_LIMITS.resources && (
                            <button
                              type="button"
                              onClick={() =>
                                setLesson(mi, li, (l) => ({
                                  ...l,
                                  resources: [...l.resources, { key: key(), title: "", url: "" }],
                                }))
                              }
                              className="flex items-center gap-1 text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                            >
                              <Icon name="plus" className="size-3.5" />
                              Add PDF
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {module.lessons.length < TRAINING_LIMITS.lessonsPerModule && (
                  <button
                    type="button"
                    onClick={() => setModule(mi, (m) => ({ ...m, lessons: [...m.lessons, emptyLesson()] }))}
                    className={buttonClasses("outline", "h-10 gap-1.5 text-sm")}
                  >
                    <Icon name="plus" className="size-4" />
                    Add lesson
                  </button>
                )}
              </Panel>
            );
          })}

          {draft.modules.length < TRAINING_LIMITS.modules && (
            <button
              type="button"
              onClick={() => setDraft((d) => ({ ...d, modules: [...d.modules, emptyModule()] }))}
              className={buttonClasses("outline", "h-10 gap-1.5 text-sm")}
            >
              <Icon name="plus" className="size-4" />
              Add module
            </button>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Removing a lesson from a published course removes it from learners&apos; progress figures; their records are
            kept.
          </p>
        </section>

        <div className="sticky bottom-0 -mx-5 border-t border-foreground/8 bg-background/95 px-5 py-3 backdrop-blur">
          <Button type="submit" loading={saving}>
            {saving ? "Saving…" : course ? "Save changes" : "Create draft"}
          </Button>
        </div>
      </form>
    </div>
  );
}
