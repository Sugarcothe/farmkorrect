import "server-only";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { ADMIN_PAGE_SIZE } from "@/lib/admin/types";
import { cleanText } from "@/lib/profile/validation";
import { searchWords } from "@/lib/training/query";
import {
  categoryLabel,
  isCourseCategory,
  isDifficulty,
  TRAINING_LIMITS,
  type AdminCourse,
  type AdminCoursePage,
  type CourseCategory,
  type CourseStatus,
  type Difficulty,
} from "@/lib/training/types";
import { recordAudit } from "./admin-audit";
import { HttpError } from "./http";
import type { CourseDoc, CourseLessonDoc, CourseModuleDoc, CourseResourceDoc, UserDoc } from "./models";
import { inTransaction } from "./order-store";
import { trainingCollections } from "./training";
import { checkMediaUrl, isMediaConfigured, MEDIA_HINT, MEDIA_UNCONFIGURED, type MediaKind } from "./training-media";

// The Academy's content management, for configured admins only (every route
// calls requireAdminRequest itself). Courses start as private drafts; nothing
// reaches learners until an admin publishes it. Module, lesson and resource
// ids are issued here and kept through every edit, so learners' progress
// stays attached to the right lesson. Every change is audited in the same
// transaction.

export const ADMIN_COURSE_NOT_FOUND = "We couldn't find that course.";
export const STALE_COURSE = "This course was changed since you opened it. Reload it and try again.";
/** the whole course form is one request */
export const MAX_COURSE_BYTES = 256 * 1024;

const newId = () => randomBytes(8).toString("hex");
const ID = /^[0-9a-f]{16}$/;

type CourseFields = Omit<CourseDoc, "_id" | "status" | "publishedAt" | "createdBy" | "createdAt" | "updatedAt">;
/** `updatedAt`: the version the admin edited (updates only) */
type Parsed = { fields: CourseFields; updatedAt: Date | null };

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);
const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Validates the whole course form. `existing` is the stored course when
 * editing: an id in the form must be one of its ids of the same kind (an
 * unknown id is refused, never adopted), and anything without an id is new.
 */
export function parseCourseInput(body: Record<string, unknown>, existing: CourseDoc | null): Parsed {
  const errors: Record<string, string> = {};
  const L = TRAINING_LIMITS;

  const text = (key: string, value: unknown, limits: { min: number; max: number }, multiline = false) => {
    const cleaned = typeof value === "string" ? cleanText(value, multiline) : "";
    if (cleaned.length < limits.min)
      errors[key] = cleaned ? `Use at least ${limits.min} characters.` : "This is required.";
    else if (cleaned.length > limits.max) errors[key] = `Keep it to ${limits.max} characters or fewer.`;
    return cleaned;
  };
  const media = (key: string, value: unknown, kind: MediaKind): string | null => {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
    if (!isMediaConfigured()) {
      errors[key] = MEDIA_UNCONFIGURED;
      return null;
    }
    const url = checkMediaUrl(value, kind);
    if (!url) errors[key] = MEDIA_HINT[kind];
    return url;
  };
  const list = (key: string, value: unknown) => {
    const items = asArray(value ?? []);
    if (!items) {
      errors[key] = "Send a list.";
      return [];
    }
    const cleaned = items.map((v) => (typeof v === "string" ? cleanText(v) : "")).filter(Boolean);
    if (cleaned.length > L.listItems) errors[key] = `Add at most ${L.listItems}.`;
    else if (cleaned.some((v) => v.length > L.listItem))
      errors[key] = `Keep each to ${L.listItem} characters or fewer.`;
    return cleaned;
  };

  // ids the stored course already has, by kind
  const known = { module: new Set<string>(), lesson: new Set<string>(), resource: new Set<string>() };
  for (const m of existing?.modules ?? []) {
    known.module.add(m.id);
    for (const l of m.lessons) {
      known.lesson.add(l.id);
      for (const r of l.resources) known.resource.add(r.id);
    }
  }
  const used = new Set<string>();
  const idFor = (key: string, value: unknown, kind: keyof typeof known): string => {
    if (value === undefined || value === null || value === "") return newId();
    if (typeof value !== "string" || !ID.test(value) || !known[kind].has(value) || used.has(value)) {
      errors[key] = "This item isn't part of the course any more. Reload the course and try again.";
      return newId();
    }
    used.add(value);
    return value;
  };

  const title = text("title", body.title, L.title);
  const description = text("description", body.description, L.description, true);
  const instructor = text("instructor", body.instructor, L.instructor);
  if (!isCourseCategory(body.category)) errors.category = "Choose a category.";
  if (!isDifficulty(body.difficulty)) errors.difficulty = "Choose a difficulty.";
  const objectives = list("objectives", body.objectives);
  const prerequisites = list("prerequisites", body.prerequisites);
  const coverUrl = media("coverUrl", body.coverUrl, "cover");
  if (body.featured !== undefined && typeof body.featured !== "boolean") errors.featured = "Send true or false.";

  const rawModules = asArray(body.modules ?? []);
  const modules: CourseModuleDoc[] = [];
  let lessonCount = 0;
  let durationSeconds = 0;
  if (!rawModules) errors.modules = "Send a list of modules.";
  else if (rawModules.length > L.modules) errors.modules = `A course can have at most ${L.modules} modules.`;
  else
    rawModules.forEach((rawModule, mi) => {
      const m = asObject(rawModule);
      const mk = `modules.${mi}`;
      const rawLessons = asArray(m.lessons ?? []);
      const lessons: CourseLessonDoc[] = [];
      if (!rawLessons) errors[`${mk}.lessons`] = "Send a list of lessons.";
      else if (rawLessons.length > L.lessonsPerModule)
        errors[`${mk}.lessons`] = `A module can have at most ${L.lessonsPerModule} lessons.`;
      else
        rawLessons.forEach((rawLesson, li) => {
          const l = asObject(rawLesson);
          const lk = `${mk}.lessons.${li}`;
          const minutes = l.durationMinutes;
          if (
            typeof minutes !== "number" ||
            !Number.isInteger(minutes) ||
            minutes < L.lessonMinutes.min ||
            minutes > L.lessonMinutes.max
          )
            errors[`${lk}.durationMinutes`] =
              `Enter whole minutes from ${L.lessonMinutes.min} to ${L.lessonMinutes.max}.`;
          const rawResources = asArray(l.resources ?? []);
          const resources: CourseResourceDoc[] = [];
          if (!rawResources) errors[`${lk}.resources`] = "Send a list of resources.";
          else if (rawResources.length > L.resources)
            errors[`${lk}.resources`] = `Add at most ${L.resources} resources.`;
          else
            rawResources.forEach((rawResource, ri) => {
              const r = asObject(rawResource);
              const rk = `${lk}.resources.${ri}`;
              const url = media(`${rk}.url`, r.url, "pdf");
              if (!url && !errors[`${rk}.url`]) errors[`${rk}.url`] = MEDIA_HINT.pdf;
              resources.push({
                id: idFor(`${rk}.id`, r.id, "resource"),
                title: text(`${rk}.title`, r.title, L.resourceTitle),
                url: url ?? "",
              });
            });
          const seconds = typeof minutes === "number" && Number.isInteger(minutes) ? minutes * 60 : 0;
          const summary = typeof l.summary === "string" ? cleanText(l.summary, true) : "";
          if (summary.length > L.lessonSummary)
            errors[`${lk}.summary`] = `Keep it to ${L.lessonSummary} characters or fewer.`;
          lessons.push({
            id: idFor(`${lk}.id`, l.id, "lesson"),
            title: text(`${lk}.title`, l.title, L.lessonTitle),
            summary,
            durationSeconds: seconds,
            videoUrl: media(`${lk}.videoUrl`, l.videoUrl, "video"),
            resources,
          });
          lessonCount += 1;
          durationSeconds += seconds;
        });
      modules.push({
        id: idFor(`${mk}.id`, m.id, "module"),
        title: text(`${mk}.title`, m.title, L.moduleTitle),
        lessons,
      });
    });
  if (lessonCount > L.lessons) errors.modules = `A course can have at most ${L.lessons} lessons.`;

  let updatedAt: Date | null = null;
  if (existing) {
    updatedAt = typeof body.updatedAt === "string" ? new Date(body.updatedAt) : null;
    if (!updatedAt || Number.isNaN(updatedAt.getTime())) throw new HttpError(409, STALE_COURSE);
  }
  if (Object.keys(errors).length) throw new HttpError(400, "Please check the course details.", errors);

  const category = body.category as CourseCategory;
  return {
    fields: {
      title,
      description,
      instructor,
      category,
      difficulty: body.difficulty as Difficulty,
      objectives,
      prerequisites,
      coverUrl,
      featured: body.featured === true,
      modules,
      lessonCount,
      durationSeconds,
      searchWords: [...new Set(searchWords(`${title} ${categoryLabel(category)} ${instructor}`))].slice(0, 80),
    },
    updatedAt,
  };
}

/** Why a course can't be published yet; empty when it can. */
export function publishIssues(course: Pick<CourseDoc, "modules">): string[] {
  const issues: string[] = [];
  const lessons = course.modules.flatMap((m) => m.lessons);
  if (lessons.length === 0) issues.push("Add at least one lesson.");
  if (course.modules.some((m) => m.lessons.length === 0)) issues.push("Remove empty modules or add lessons to them.");
  const missing = lessons.filter((l) => !checkMediaUrl(l.videoUrl, "video")).length;
  if (missing) issues.push(`Add a video to every lesson (${missing} missing).`);
  return issues;
}

export function toAdminCourse(doc: CourseDoc): AdminCourse {
  return {
    id: doc._id.toHexString(),
    status: doc.status,
    title: doc.title,
    description: doc.description,
    instructor: doc.instructor,
    category: doc.category,
    difficulty: doc.difficulty,
    objectives: doc.objectives,
    prerequisites: doc.prerequisites,
    coverUrl: doc.coverUrl,
    featured: doc.featured,
    modules: doc.modules.map((m) => ({
      id: m.id,
      title: m.title,
      lessons: m.lessons.map((l) => ({
        id: l.id,
        title: l.title,
        summary: l.summary,
        durationMinutes: Math.round(l.durationSeconds / 60),
        videoUrl: l.videoUrl,
        resources: l.resources.map((r) => ({ id: r.id, title: r.title, url: r.url })),
      })),
    })),
    lessonCount: doc.lessonCount,
    durationSeconds: doc.durationSeconds,
    publishIssues: publishIssues(doc),
    publishedAt: doc.publishedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const parseCourseObjectId = (id: string) => (/^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null);

/** Any course, draft or published (admin pages and the preview only). */
export async function findCourseForAdmin(id: string): Promise<CourseDoc | null> {
  const _id = parseCourseObjectId(id);
  if (!_id) return null;
  return (await trainingCollections()).courses.findOne({ _id });
}

export async function listCoursesForAdmin(page: number, pageSize = ADMIN_PAGE_SIZE): Promise<AdminCoursePage> {
  const { courses } = await trainingCollections();
  const docs = await courses
    .find({}, { projection: { modules: 0, searchWords: 0 } })
    .sort({ updatedAt: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .toArray();
  return {
    courses: docs.slice(0, pageSize).map((d) => ({
      id: d._id.toHexString(),
      status: d.status,
      title: d.title,
      category: d.category,
      difficulty: d.difficulty,
      featured: d.featured,
      lessonCount: d.lessonCount,
      updatedAt: d.updatedAt.toISOString(),
    })),
    page,
    hasMore: docs.length > pageSize,
  };
}

/** Creates a private draft. */
export async function createCourse(admin: UserDoc, body: Record<string, unknown>): Promise<AdminCourse> {
  const { fields } = parseCourseInput(body, null);
  const { courses } = await trainingCollections();
  const now = new Date();
  const doc: CourseDoc = {
    _id: new ObjectId(),
    status: "draft",
    ...fields,
    publishedAt: null,
    createdBy: admin._id,
    createdAt: now,
    updatedAt: now,
  };
  await inTransaction(async (session) => {
    await courses.insertOne(doc, { session });
    await recordAudit(
      {
        actorUserId: admin._id,
        action: "course.create",
        target: { type: "course", id: doc._id.toHexString() },
        to: "draft",
      },
      session,
      now,
    );
  });
  return toAdminCourse(doc);
}

/**
 * Replaces a course's details and curriculum. Published courses stay
 * published, so the change must leave them publishable.
 */
export async function updateCourse(admin: UserDoc, id: string, body: Record<string, unknown>): Promise<AdminCourse> {
  const current = await findCourseForAdmin(id);
  if (!current) throw new HttpError(404, ADMIN_COURSE_NOT_FOUND);
  const { fields, updatedAt } = parseCourseInput(body, current);
  if (current.updatedAt.getTime() !== updatedAt!.getTime()) throw new HttpError(409, STALE_COURSE);
  if (current.status === "published") {
    const issues = publishIssues(fields);
    if (issues.length)
      throw new HttpError(
        400,
        `A published course must stay complete: ${issues.join(" ")} Unpublish it first to save it as a draft.`,
      );
  }
  const { courses } = await trainingCollections();
  const saved = await inTransaction(async (session) => {
    const now = new Date();
    const doc = await courses.findOneAndUpdate(
      { _id: current._id, updatedAt: current.updatedAt },
      { $set: { ...fields, updatedAt: now } },
      { returnDocument: "after", session },
    );
    if (!doc) return null;
    await recordAudit(
      { actorUserId: admin._id, action: "course.update", target: { type: "course", id: doc._id.toHexString() } },
      session,
      now,
    );
    return doc;
  });
  if (!saved) throw new HttpError(409, STALE_COURSE);
  return toAdminCourse(saved);
}

export function parseStatusChange(body: Record<string, unknown>): { action: "publish" | "unpublish"; updatedAt: Date } {
  const action = body.action;
  if (action !== "publish" && action !== "unpublish")
    throw new HttpError(400, "Choose publish or unpublish.", { action: "Choose publish or unpublish." });
  const updatedAt = typeof body.updatedAt === "string" ? new Date(body.updatedAt) : null;
  if (!updatedAt || Number.isNaN(updatedAt.getTime())) throw new HttpError(409, STALE_COURSE);
  return { action, updatedAt };
}

/** Publishes a complete draft, or takes a published course back to draft. Learners' progress is kept either way. */
export async function setCourseStatus(
  admin: UserDoc,
  id: string,
  change: { action: "publish" | "unpublish"; updatedAt: Date },
): Promise<AdminCourse> {
  const current = await findCourseForAdmin(id);
  if (!current) throw new HttpError(404, ADMIN_COURSE_NOT_FOUND);
  const from: CourseStatus = change.action === "publish" ? "draft" : "published";
  const to: CourseStatus = change.action === "publish" ? "published" : "draft";
  if (current.status !== from || current.updatedAt.getTime() !== change.updatedAt.getTime())
    throw new HttpError(409, STALE_COURSE);
  if (change.action === "publish") {
    const issues = publishIssues(current);
    if (issues.length) throw new HttpError(400, `This course can't be published yet: ${issues.join(" ")}`);
  }
  const { courses } = await trainingCollections();
  const saved = await inTransaction(async (session) => {
    const now = new Date();
    const doc = await courses.findOneAndUpdate(
      { _id: current._id, status: from, updatedAt: current.updatedAt },
      { $set: { status: to, updatedAt: now, ...(to === "published" ? { publishedAt: now } : {}) } },
      { returnDocument: "after", session },
    );
    if (!doc) return null;
    await recordAudit(
      {
        actorUserId: admin._id,
        action: change.action === "publish" ? "course.publish" : "course.unpublish",
        target: { type: "course", id: doc._id.toHexString() },
        from,
        to,
      },
      session,
      now,
    );
    return doc;
  });
  if (!saved) throw new HttpError(409, STALE_COURSE);
  return toAdminCourse(saved);
}
