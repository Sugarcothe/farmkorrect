import "server-only";
import { MongoServerError, ObjectId, type Filter } from "mongodb";
import { canonicalCatalogQuery } from "@/lib/training/query";
import {
  TRAINING_LIMITS,
  type CatalogPage,
  type CatalogQuery,
  type CompleteResponse,
  type ContinueItem,
  type CourseCard,
  type CourseDetail,
  type CourseProgress,
  type EnrollResponse,
  type LessonView,
  type ModuleOutline,
  type TrainingHome,
} from "@/lib/training/types";
import { getAuthConfig } from "./config";
import { hmac, safeEqualHex } from "./crypto";
import { getDb } from "./db";
import { HttpError } from "./http";
import {
  COLLECTIONS,
  type CourseDoc,
  type CourseEnrollmentDoc,
  type CourseLessonDoc,
  type CourseModuleDoc,
  type FarmDoc,
  type FarmStaffDoc,
  type LessonProgressDoc,
  type TrainingProgramDoc,
  type UserDoc,
} from "./models";
import { checkMediaUrl } from "./training-media";

// Korret Academy for learners: the catalogue, a course, a lesson and the
// learner's own progress. Only published courses are ever read here; a draft
// or unpublished course looks exactly like one that doesn't exist. The
// learner is always the session's user, and progress figures are always
// calculated from their completion records against the current curriculum.

export async function trainingCollections() {
  const db = await getDb();
  return {
    courses: db.collection<CourseDoc>(COLLECTIONS.courses),
    enrollments: db.collection<CourseEnrollmentDoc>(COLLECTIONS.courseEnrollments),
    progress: db.collection<LessonProgressDoc>(COLLECTIONS.lessonProgress),
    staff: db.collection<FarmStaffDoc>(COLLECTIONS.farmStaff),
    programs: db.collection<TrainingProgramDoc>(COLLECTIONS.trainingPrograms),
    farms: db.collection<FarmDoc>(COLLECTIONS.farms),
    users: db.collection<UserDoc>(COLLECTIONS.users),
  };
}

export const TRAINING_UNVERIFIED = "Verify your phone number before using Training.";
export const COURSE_NOT_FOUND = "We couldn't find that course. It may no longer be available.";
export const LESSON_NOT_FOUND = "We couldn't find that lesson. The course may have changed.";

/** A strict 24-hex-digit id, or null. */
export const parseObjectId = (id: unknown): ObjectId | null =>
  typeof id === "string" && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;

const LESSON_ID = /^[0-9a-f]{16}$/;
export const isLessonId = (id: unknown): id is string => typeof id === "string" && LESSON_ID.test(id);

/** On a duplicate-key race the other request's document now exists, so a retry updates it. */
export async function retryOnDuplicate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return work();
    throw error;
  }
}

// --- curriculum and progress ------------------------------------------------------

export type PlacedLesson = { module: CourseModuleDoc; moduleIndex: number; lesson: CourseLessonDoc };

/** Every lesson in curriculum order. */
export function flattenLessons(course: Pick<CourseDoc, "modules">): PlacedLesson[] {
  return course.modules.flatMap((module, moduleIndex) =>
    module.lessons.map((lesson) => ({ module, moduleIndex, lesson })),
  );
}

/** Progress through the current curriculum: completions of removed lessons don't count. */
export function progressOf(course: Pick<CourseDoc, "modules">, completed: ReadonlySet<string>): CourseProgress {
  const lessons = flattenLessons(course);
  const done = lessons.filter((l) => completed.has(l.lesson.id)).length;
  const total = lessons.length;
  return {
    completedLessons: done,
    totalLessons: total,
    percent: total ? Math.floor((done / total) * 100) : 0,
    complete: total > 0 && done === total,
  };
}

/** The learner's completed lesson ids per course, for at most a few courses at once. */
export async function completedLessonIds(userId: ObjectId, courseIds: ObjectId[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(courseIds.map((id) => [id.toHexString(), new Set<string>()]));
  if (courseIds.length === 0) return out;
  const { progress } = await trainingCollections();
  const docs = await progress
    .find(
      { userId, courseId: { $in: courseIds }, completedAt: { $ne: null } },
      { projection: { courseId: 1, lessonId: 1 } },
    )
    .limit(courseIds.length * TRAINING_LIMITS.lessons * 2)
    .toArray();
  for (const d of docs) out.get(d.courseId.toHexString())?.add(d.lessonId);
  return out;
}

/** Where Start/Resume goes: the last lesson worked on if unfinished, else the first unfinished, else the first. */
export function resumeLesson(
  course: Pick<CourseDoc, "modules">,
  completed: ReadonlySet<string>,
  lastLessonId: string | null,
): string | null {
  const lessons = flattenLessons(course);
  if (lastLessonId && lessons.some((l) => l.lesson.id === lastLessonId) && !completed.has(lastLessonId))
    return lastLessonId;
  return (lessons.find((l) => !completed.has(l.lesson.id)) ?? lessons[0])?.lesson.id ?? null;
}

function outline(course: CourseDoc, completed: ReadonlySet<string>): ModuleOutline[] {
  return course.modules.map((m) => ({
    id: m.id,
    title: m.title,
    lessons: m.lessons.map((l) => ({
      id: l.id,
      title: l.title,
      durationSeconds: l.durationSeconds,
      completed: completed.has(l.id),
      hasVideo: checkMediaUrl(l.videoUrl, "video") !== null,
      resourceCount: l.resources.filter((r) => checkMediaUrl(r.url, "pdf")).length,
    })),
  }));
}

/** A course as a card. Shared with the admin preview, which shows drafts. */
export function toCard(
  doc: Pick<
    CourseDoc,
    | "_id"
    | "title"
    | "instructor"
    | "category"
    | "difficulty"
    | "lessonCount"
    | "durationSeconds"
    | "coverUrl"
    | "featured"
  >,
): CourseCard {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    instructor: doc.instructor,
    category: doc.category,
    difficulty: doc.difficulty,
    lessonCount: doc.lessonCount,
    durationSeconds: doc.durationSeconds,
    coverUrl: checkMediaUrl(doc.coverUrl, "cover"),
    featured: doc.featured,
  };
}

/** Everything a card needs, without the curriculum. */
export const CARD_PROJECTION = {
  _id: 1,
  title: 1,
  instructor: 1,
  category: 1,
  difficulty: 1,
  lessonCount: 1,
  durationSeconds: 1,
  coverUrl: 1,
  featured: 1,
  publishedAt: 1,
} as const;

export async function findPublishedCourse(id: unknown): Promise<CourseDoc | null> {
  const _id = parseObjectId(id);
  if (!_id) return null;
  const { courses } = await trainingCollections();
  return courses.findOne({ _id, status: "published" });
}

async function requirePublishedLesson(courseId: unknown, lessonId: unknown) {
  const course = await findPublishedCourse(courseId);
  if (!course) throw new HttpError(404, COURSE_NOT_FOUND);
  const placed = isLessonId(lessonId) ? flattenLessons(course).find((l) => l.lesson.id === lessonId) : undefined;
  if (!placed) throw new HttpError(404, LESSON_NOT_FOUND);
  return { course, placed };
}

// --- the catalogue -------------------------------------------------------------------

function cursorSignature(query: CatalogQuery, payload: string) {
  return hmac(getAuthConfig().secret, "course-catalog-cursor", canonicalCatalogQuery(query), payload).slice(0, 32);
}

export function encodeCatalogCursor(query: CatalogQuery, doc: Pick<CourseDoc, "_id" | "publishedAt">): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, t: doc.publishedAt?.getTime() ?? 0, i: doc._id.toHexString() }),
  ).toString("base64url");
  return `${payload}.${cursorSignature(query, payload)}`;
}

export const BAD_CATALOG_CURSOR = "This list has changed. Start the search again.";

/** A cursor is only accepted with the exact filters it was made for, and its contents are checked even then. */
export function decodeCatalogCursor(query: CatalogQuery, cursor: string): { at: Date; id: ObjectId } {
  const bad = () => new HttpError(400, BAD_CATALOG_CURSOR);
  if (cursor.length > 300) throw bad();
  const [payload, signature, extra] = cursor.split(".");
  if (!payload || !signature || extra !== undefined || !/^[0-9a-f]{32}$/.test(signature)) throw bad();
  if (!safeEqualHex(signature, cursorSignature(query, payload))) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const { v, t, i } = (parsed ?? {}) as Record<string, unknown>;
  if (v !== 1 || !Number.isSafeInteger(t) || (t as number) < 0 || typeof i !== "string" || !/^[0-9a-f]{24}$/.test(i))
    throw bad();
  return { at: new Date(t as number), id: new ObjectId(i) };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The filter for a query (before the cursor): published only, then every filter. */
export function catalogFilter(query: CatalogQuery): Filter<CourseDoc> {
  const filter: Filter<CourseDoc> = { status: "published" };
  if (query.category) filter.category = query.category;
  if (query.difficulty) filter.difficulty = query.difficulty;
  if (query.q) filter.searchWords = { $all: query.q.split(" ").map((w) => new RegExp(`^${escapeRegex(w)}`)) };
  return filter;
}

/** One page of published courses, newest publication first (keyset paging, no counts). */
export async function searchCatalog(query: CatalogQuery, cursor: string | null, limit: number): Promise<CatalogPage> {
  const { courses } = await trainingCollections();
  const filter = catalogFilter(query);
  if (cursor) {
    const { at, id } = decodeCatalogCursor(query, cursor);
    filter.$or = [{ publishedAt: { $lt: at } }, { publishedAt: at, _id: { $lt: id } }];
  }
  const docs = await courses
    .find(filter, { projection: CARD_PROJECTION })
    .sort({ publishedAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();
  const page = docs.slice(0, limit);
  return {
    courses: page.map(toCard),
    nextCursor: docs.length > limit ? encodeCatalogCursor(query, page[page.length - 1]) : null,
  };
}

const FEATURED_LIMIT = 6;
const CONTINUE_LIMIT = 3;
/** recent enrolments looked at for Continue Learning */
const RECENT_ENROLLMENTS = 10;

/** Continue Learning (the learner's unfinished courses, most recent first) and the featured courses. */
export async function getTrainingHome(userId: ObjectId): Promise<TrainingHome> {
  const { courses, enrollments } = await trainingCollections();
  const [featured, recent] = await Promise.all([
    courses
      .find({ status: "published", featured: true }, { projection: CARD_PROJECTION })
      .sort({ publishedAt: -1 })
      .limit(FEATURED_LIMIT)
      .toArray(),
    enrollments.find({ userId }).sort({ lastActivityAt: -1 }).limit(RECENT_ENROLLMENTS).toArray(),
  ]);
  const ids = recent.map((e) => e.courseId);
  const [docs, done] = await Promise.all([
    courses
      .find({ _id: { $in: ids }, status: "published" })
      .limit(ids.length)
      .toArray(),
    completedLessonIds(userId, ids),
  ]);
  const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
  const continueLearning: ContinueItem[] = [];
  for (const e of recent) {
    const course = byId.get(e.courseId.toHexString());
    if (!course) continue;
    const completed = done.get(course._id.toHexString())!;
    const progress = progressOf(course, completed);
    if (progress.complete || progress.totalLessons === 0) continue;
    continueLearning.push({
      ...toCard(course),
      progress,
      resumeLessonId: resumeLesson(course, completed, e.lastLessonId),
    });
    if (continueLearning.length === CONTINUE_LIMIT) break;
  }
  return { continueLearning, featured: featured.map(toCard) };
}

// --- a course and a lesson ---------------------------------------------------------------

/** A course's page for this learner, built from any course document (the admin preview passes a draft). */
export function buildCourseDetail(
  course: CourseDoc,
  completed: ReadonlySet<string>,
  enrollment: Pick<CourseEnrollmentDoc, "lastLessonId"> | null,
): CourseDetail {
  return {
    ...toCard(course),
    description: course.description,
    objectives: course.objectives,
    prerequisites: course.prerequisites,
    modules: outline(course, completed),
    enrolled: enrollment !== null,
    progress: progressOf(course, completed),
    resumeLessonId: resumeLesson(course, completed, enrollment?.lastLessonId ?? null),
  };
}

export async function getCourseDetail(userId: ObjectId, id: unknown): Promise<CourseDetail | null> {
  const course = await findPublishedCourse(id);
  if (!course) return null;
  const { enrollments } = await trainingCollections();
  const [enrollment, done] = await Promise.all([
    enrollments.findOne({ userId, courseId: course._id }),
    completedLessonIds(userId, [course._id]),
  ]);
  return buildCourseDetail(course, done.get(course._id.toHexString())!, enrollment);
}

export async function getLessonView(
  userId: ObjectId,
  courseId: unknown,
  lessonId: unknown,
): Promise<LessonView | null> {
  const course = await findPublishedCourse(courseId);
  const placed =
    course && isLessonId(lessonId) ? flattenLessons(course).find((l) => l.lesson.id === lessonId) : undefined;
  if (!course || !placed) return null;
  const { progress } = await trainingCollections();
  const [record, done] = await Promise.all([
    progress.findOne({ userId, courseId: course._id, lessonId: placed.lesson.id }),
    completedLessonIds(userId, [course._id]),
  ]);
  const completed = done.get(course._id.toHexString())!;
  const lessons = flattenLessons(course);
  const index = lessons.findIndex((l) => l.lesson.id === placed.lesson.id);
  const { lesson } = placed;
  return {
    course: { id: course._id.toHexString(), title: course.title },
    module: { id: placed.module.id, title: placed.module.title, index: placed.moduleIndex },
    lesson: {
      id: lesson.id,
      title: lesson.title,
      summary: lesson.summary,
      durationSeconds: lesson.durationSeconds,
      videoUrl: checkMediaUrl(lesson.videoUrl, "video"),
      resources: lesson.resources.flatMap((r) => {
        const url = checkMediaUrl(r.url, "pdf");
        return url ? [{ id: r.id, title: r.title, url }] : [];
      }),
      positionSeconds: record?.positionSeconds ?? 0,
      completed: completed.has(lesson.id),
    },
    previousLessonId: lessons[index - 1]?.lesson.id ?? null,
    nextLessonId: lessons[index + 1]?.lesson.id ?? null,
    modules: outline(course, completed),
    progress: progressOf(course, completed),
  };
}

// --- writes (always the session's own records) ----------------------------------------------

/** Creates the learner's enrolment once; later calls change nothing but the activity time. */
async function touchEnrollment(userId: ObjectId, courseId: ObjectId, lastLessonId: string | null, now: Date) {
  const { enrollments } = await trainingCollections();
  await retryOnDuplicate(() =>
    enrollments.updateOne(
      { userId, courseId },
      {
        $set: { lastActivityAt: now, ...(lastLessonId ? { lastLessonId } : {}) },
        $setOnInsert: {
          _id: new ObjectId(),
          userId,
          courseId,
          enrolledAt: now,
          completedAt: null,
          ...(lastLessonId ? {} : { lastLessonId: null }),
        },
      },
      { upsert: true },
    ),
  );
}

export async function enroll(userId: ObjectId, courseId: unknown): Promise<EnrollResponse> {
  const course = await findPublishedCourse(courseId);
  if (!course) throw new HttpError(404, COURSE_NOT_FOUND);
  await touchEnrollment(userId, course._id, null, new Date());
  const { enrollments } = await trainingCollections();
  const [enrollment, done] = await Promise.all([
    enrollments.findOne({ userId, courseId: course._id }),
    completedLessonIds(userId, [course._id]),
  ]);
  return {
    enrolled: true,
    resumeLessonId: resumeLesson(course, done.get(course._id.toHexString())!, enrollment?.lastLessonId ?? null),
  };
}

/** Reads a playback position: whole seconds from 0 to 12 hours. */
export function parsePosition(body: Record<string, unknown>): number {
  const value = body.positionSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > TRAINING_LIMITS.maxPositionSeconds)
    throw new HttpError(400, "That playback position isn't valid.", { positionSeconds: "Send a number of seconds." });
  return Math.floor(value);
}

async function upsertProgress(
  userId: ObjectId,
  courseId: ObjectId,
  lessonId: string,
  set: Partial<LessonProgressDoc>,
  now: Date,
) {
  const { progress } = await trainingCollections();
  await retryOnDuplicate(() =>
    progress.updateOne(
      { userId, courseId, lessonId },
      {
        $set: { ...set, updatedAt: now },
        $setOnInsert: {
          _id: new ObjectId(),
          userId,
          courseId,
          lessonId,
          ...("positionSeconds" in set ? {} : { positionSeconds: 0 }),
          completedAt: null,
          createdAt: now,
        },
      },
      { upsert: true },
    ),
  );
}

/** Saves where the learner is in a lesson's video. Never touches completion. */
export async function savePosition(userId: ObjectId, courseId: unknown, lessonId: unknown, seconds: number) {
  const { course, placed } = await requirePublishedLesson(courseId, lessonId);
  const now = new Date();
  await upsertProgress(userId, course._id, placed.lesson.id, { positionSeconds: seconds }, now);
  await touchEnrollment(userId, course._id, placed.lesson.id, now);
  return { positionSeconds: seconds };
}

/**
 * Marks a lesson complete for the learner. Idempotent: the first completion
 * time is kept, and finishing the curriculum records the course's first
 * completion once.
 */
export async function completeLesson(
  userId: ObjectId,
  courseId: unknown,
  lessonId: unknown,
): Promise<CompleteResponse> {
  const { course, placed } = await requirePublishedLesson(courseId, lessonId);
  const { progress: records, enrollments } = await trainingCollections();
  const now = new Date();
  await upsertProgress(userId, course._id, placed.lesson.id, {}, now);
  await records.updateOne(
    { userId, courseId: course._id, lessonId: placed.lesson.id, completedAt: null },
    { $set: { completedAt: now, updatedAt: now } },
  );
  await touchEnrollment(userId, course._id, placed.lesson.id, now);
  const completed = (await completedLessonIds(userId, [course._id])).get(course._id.toHexString())!;
  const progress = progressOf(course, completed);
  if (progress.complete)
    await enrollments.updateOne({ userId, courseId: course._id, completedAt: null }, { $set: { completedAt: now } });
  const lessons = flattenLessons(course);
  const index = lessons.findIndex((l) => l.lesson.id === placed.lesson.id);
  return { lessonId: placed.lesson.id, completed: true, progress, nextLessonId: lessons[index + 1]?.lesson.id ?? null };
}
