import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { GET as adminCourseRoute, PUT as updateCourseRoute } from "@/app/api/admin/training/courses/[id]/route";
import { POST as statusRoute } from "@/app/api/admin/training/courses/[id]/status/route";
import { GET as adminListRoute, POST as createCourseRoute } from "@/app/api/admin/training/courses/route";
import { POST as respondRoute } from "@/app/api/training/invitations/[id]/route";
import { GET as invitationsRoute } from "@/app/api/training/invitations/route";
import { POST as enrollRoute } from "@/app/api/training/courses/[id]/enroll/route";
import { POST as completeRoute } from "@/app/api/training/courses/[id]/lessons/[lessonId]/complete/route";
import { PUT as positionRoute } from "@/app/api/training/courses/[id]/lessons/[lessonId]/position/route";
import { GET as lessonRoute } from "@/app/api/training/courses/[id]/lessons/[lessonId]/route";
import { GET as courseRoute } from "@/app/api/training/courses/[id]/route";
import { GET as catalogRoute } from "@/app/api/training/courses/route";
import { PUT as programRoute } from "@/app/api/training/staff/programs/[role]/route";
import { DELETE as removeStaffRoute, PATCH as staffRoleRoute } from "@/app/api/training/staff/[id]/route";
import { GET as staffRoute, POST as inviteRoute } from "@/app/api/training/staff/route";
import { getDb } from "@/lib/server/db";
import { COLLECTIONS, type AdminAuditDoc } from "@/lib/server/models";
import { BAD_CATALOG_CURSOR, getTrainingHome, trainingCollections } from "@/lib/server/training";
import { myAssignments } from "@/lib/server/training-staff";
import type {
  AdminCourse,
  AdminCourseResponse,
  AdminCoursePage,
  CatalogPage,
  CompleteResponse,
  CourseDetail,
  EnrollResponse,
  InvitationResponse,
  LessonView,
  ModuleInput,
  ProgramResponse,
  StaffInvitation,
  StaffMemberResponse,
  StaffOverview,
} from "@/lib/training/types";
import { newRegistration, registerPending, registerVerified, registerWithFarm } from "./support/flows";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { userByPhone } from "./support/db";
import { merchant } from "./support/wallet";

// Korret Academy against the real route handlers and an in-memory replica
// set. Courses are created and published through the admin API by an
// allowlisted admin; learners and farm owners are ordinary verified accounts.
// Media references point at the test Cloudinary cloud ("test-cloud"); nothing
// is uploaded or fetched.

const VIDEO = "https://res.cloudinary.com/test-cloud/video/upload/v1/lesson.mp4";
const COVER = "https://res.cloudinary.com/test-cloud/image/upload/v1/cover.jpg";
const PDF = "https://res.cloudinary.com/test-cloud/raw/upload/v1/guide.pdf";

type Account = Awaited<ReturnType<typeof merchant>>;
type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

function callWith<T, P>(handler: Handler<P>, path: string, params: P, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve(params) }), path, options);
}
const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

// --- fixtures ----------------------------------------------------------------------

const lessonInput = (title: string, extra: object = {}) => ({
  title,
  summary: "What this lesson covers.",
  durationMinutes: 10,
  videoUrl: VIDEO,
  resources: [],
  ...extra,
});

function courseBody(overrides: object = {}) {
  return {
    title: "Broiler Health Basics",
    description: "Keeping a broiler flock healthy from day-old chicks to market weight.",
    instructor: "Test Instructor",
    category: "poultry-health",
    difficulty: "beginner",
    objectives: ["Spot early signs of disease"],
    prerequisites: [],
    coverUrl: COVER,
    featured: false,
    modules: [
      {
        title: "Getting started",
        lessons: [
          lessonInput("Lesson one"),
          lessonInput("Lesson two", { resources: [{ title: "Checklist", url: PDF }] }),
        ],
      },
      { title: "Going further", lessons: [lessonInput("Lesson three")] },
    ],
    ...overrides,
  };
}

/** The same course sent back for an update (a copy), keeping every server-issued id. */
const asInput = (c: AdminCourse) => ({
  title: c.title,
  description: c.description,
  instructor: c.instructor,
  category: c.category,
  difficulty: c.difficulty,
  objectives: c.objectives,
  prerequisites: c.prerequisites,
  coverUrl: c.coverUrl ?? "",
  featured: c.featured,
  modules: c.modules.map((m): ModuleInput => ({
    id: m.id,
    title: m.title,
    lessons: m.lessons.map((l) => ({
      ...l,
      videoUrl: l.videoUrl ?? "",
      resources: l.resources.map((r) => ({ ...r })),
    })),
  })),
  updatedAt: c.updatedAt as string | undefined,
});

let admin: Account | null = null;

/** An admin account (ADMIN_USER_IDS is reset before every test). */
async function adminAccount() {
  admin = await merchant("poultry-farmer");
  vi.stubEnv("ADMIN_USER_IDS", admin.userId.toHexString());
  return admin;
}
async function boss() {
  if (admin && process.env.ADMIN_USER_IDS === admin.userId.toHexString()) return admin;
  return adminAccount();
}

async function createDraft(overrides: object = {}) {
  const res = await call<AdminCourseResponse>(createCourseRoute, "/api/admin/training/courses", {
    body: courseBody(overrides),
    cookie: (await boss()).cookie,
  });
  expect(res.status).toBe(201);
  return dataOf(res).course;
}

/** Lets the clock move on, so every saved version has its own updatedAt. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function putCourse(id: string, body: object, cookie?: string) {
  await tick();
  return callWith<AdminCourseResponse, { id: string }>(
    updateCourseRoute,
    `/api/admin/training/courses/${id}`,
    { id },
    { body, cookie: cookie ?? (await boss()).cookie, method: "PUT" },
  );
}

async function changeStatus(course: AdminCourse, action: "publish" | "unpublish", cookie?: string) {
  await tick();
  return callWith<AdminCourseResponse, { id: string }>(
    statusRoute,
    `/api/admin/training/courses/${course.id}/status`,
    { id: course.id },
    { body: { action, updatedAt: course.updatedAt }, cookie: cookie ?? (await boss()).cookie },
  );
}

async function setStatus(course: AdminCourse, action: "publish" | "unpublish") {
  const res = await changeStatus(course, action);
  expect(res.status).toBe(200);
  return dataOf(res).course;
}

const publishedCourse = async (overrides: object = {}) => setStatus(await createDraft(overrides), "publish");

const lessonIds = (c: AdminCourse) => c.modules.flatMap((m) => m.lessons.map((l) => l.id));

// --- learner calls -------------------------------------------------------------------

const search = (cookie: string | null, qs = "") =>
  call<CatalogPage>(catalogRoute, `/api/training/courses${qs ? `?${qs}` : ""}`, { cookie });
const detail = (cookie: string, id: string) =>
  callWith<CourseDetail, { id: string }>(courseRoute, `/api/training/courses/${id}`, { id }, { cookie });
const enroll = (cookie: string, id: string, options: CallOptions = {}) =>
  callWith<EnrollResponse, { id: string }>(
    enrollRoute,
    `/api/training/courses/${id}/enroll`,
    { id },
    { body: {}, cookie, ...options },
  );
const lessonPath = (id: string, lessonId: string) => `/api/training/courses/${id}/lessons/${lessonId}`;
const viewLesson = (cookie: string, id: string, lessonId: string) =>
  callWith<LessonView, { id: string; lessonId: string }>(
    lessonRoute,
    lessonPath(id, lessonId),
    { id, lessonId },
    { cookie },
  );
const putPosition = (cookie: string, id: string, lessonId: string, body: unknown, options: CallOptions = {}) =>
  callWith<{ positionSeconds: number }, { id: string; lessonId: string }>(
    positionRoute,
    `${lessonPath(id, lessonId)}/position`,
    { id, lessonId },
    { body, cookie, method: "PUT", ...options },
  );
const complete = (cookie: string, id: string, lessonId: string, body: unknown = {}, options: CallOptions = {}) =>
  callWith<CompleteResponse, { id: string; lessonId: string }>(
    completeRoute,
    `${lessonPath(id, lessonId)}/complete`,
    { id, lessonId },
    { body, cookie, ...options },
  );

async function learner() {
  const { input, cookie } = await registerVerified();
  const user = await userByPhone(input.phone);
  return { cookie, userId: user!._id, phone: input.phone };
}

async function allPages(cookie: string, qs: string) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i += 1) {
    const res: CallResult<CatalogPage> = await search(
      cookie,
      cursor ? `${qs}&cursor=${encodeURIComponent(cursor)}` : qs,
    );
    expect(res.status).toBe(200);
    const page = dataOf(res);
    ids.push(...page.courses.map((c) => c.id));
    cursor = page.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error("Paging never ended.");
}

// --- staff calls -------------------------------------------------------------------------

async function owner() {
  const { input, cookie } = await registerWithFarm();
  const user = await userByPhone(input.phone);
  return { cookie, userId: user!._id, phone: input.phone };
}
const invite = (cookie: string, body: object) =>
  call<StaffMemberResponse>(inviteRoute, "/api/training/staff", { body, cookie });
const overview = (cookie: string) => call<StaffOverview>(staffRoute, "/api/training/staff", { cookie });
const respond = (cookie: string, id: string, decision: unknown) =>
  callWith<InvitationResponse, { id: string }>(
    respondRoute,
    `/api/training/invitations/${id}`,
    { id },
    { body: { decision }, cookie },
  );
const setProgram = (cookie: string, role: string, courseIds: unknown) =>
  callWith<ProgramResponse, { role: string }>(
    programRoute,
    `/api/training/staff/programs/${role}`,
    { role },
    {
      body: { courseIds },
      cookie,
      method: "PUT",
    },
  );
const patchMember = (cookie: string, id: string, body: object) =>
  callWith(staffRoleRoute, `/api/training/staff/${id}`, { id }, { body, cookie, method: "PATCH" });
const removeMember = (cookie: string, id: string) =>
  callWith(removeStaffRoute, `/api/training/staff/${id}`, { id }, { cookie, method: "DELETE" });

async function invited(farmOwner: { cookie: string }, phone: string, role = "farm-attendant") {
  const res = await invite(farmOwner.cookie, { phone, role });
  expect(res.status).toBe(201);
  return dataOf(res).member;
}

// =====================================================================================

describe("Korret Academy catalogue", () => {
  it("needs a signed-in, verified account", async () => {
    expect((await search(null)).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await search(pendingCookie)).status).toBe(403);
  });

  it("returns an empty catalogue when nothing is published", async () => {
    const { cookie } = await learner();
    await createDraft();
    expect(dataOf(await search(cookie))).toEqual({ courses: [], nextCursor: null });
    expect(await getTrainingHome((await learner()).userId)).toEqual({ continueLearning: [], featured: [] });
  });

  it("lists only published courses; drafts and unpublished courses can't be opened", async () => {
    const { cookie } = await learner();
    const draft = await createDraft({ title: "Draft course" });
    const live = await publishedCourse({ title: "Live course" });
    const withdrawn = await setStatus(await publishedCourse({ title: "Withdrawn course" }), "unpublish");

    expect(dataOf(await search(cookie)).courses.map((c) => c.id)).toEqual([live.id]);
    expect(dataOf(await search(cookie, "q=course")).courses.map((c) => c.id)).toEqual([live.id]);
    for (const hidden of [draft, withdrawn]) {
      const [lessonId] = lessonIds(hidden);
      expect((await detail(cookie, hidden.id)).status).toBe(404);
      expect((await viewLesson(cookie, hidden.id, lessonId)).status).toBe(404);
      expect((await enroll(cookie, hidden.id)).status).toBe(404);
      expect((await putPosition(cookie, hidden.id, lessonId, { positionSeconds: 5 })).status).toBe(404);
      expect((await complete(cookie, hidden.id, lessonId)).status).toBe(404);
    }
    const { enrollments, progress } = await trainingCollections();
    expect(await enrollments.countDocuments()).toBe(0);
    expect(await progress.countDocuments()).toBe(0);
    // ids that aren't course ids at all look the same
    expect((await detail(cookie, "not-an-id")).status).toBe(404);
    expect((await detail(cookie, new ObjectId().toHexString())).status).toBe(404);
  });

  it("searches title, topic and instructor, and filters by category and difficulty", async () => {
    const { cookie } = await learner();
    const broiler = await publishedCourse({ title: "Broiler Health Basics", instructor: "Ngozi Eze" });
    const bio = await publishedCourse({
      title: "Keeping Disease Out",
      category: "biosecurity",
      difficulty: "intermediate",
      instructor: "Tunde Bello",
    });
    const eggs = await publishedCourse({
      title: "Grading Eggs for Market",
      category: "egg-production",
      difficulty: "advanced",
      instructor: "Ngozi Eze",
    });
    const ids = async (qs: string) => dataOf(await search(cookie, qs)).courses.map((c) => c.id);

    expect(await ids("q=broiler")).toEqual([broiler.id]);
    expect(await ids("q=BROIL")).toEqual([broiler.id]); // word prefixes, any case
    expect(await ids("q=biosecurity")).toEqual([bio.id]); // the category's label
    expect(await ids("q=bello")).toEqual([bio.id]);
    expect(await ids("q=ngozi")).toEqual([eggs.id, broiler.id]); // newest publication first
    expect(await ids("q=ngozi%20eggs")).toEqual([eggs.id]); // every word must match
    expect(await ids("q=turkeys")).toEqual([]);
    expect(await ids("category=biosecurity")).toEqual([bio.id]);
    expect(await ids("difficulty=advanced")).toEqual([eggs.id]);
    expect(await ids("q=ngozi&difficulty=beginner")).toEqual([broiler.id]);
    expect(await ids("category=hatchery")).toEqual([]);
  });

  it("pages with a cursor, without gaps or repeats", async () => {
    const { cookie } = await learner();
    for (let i = 1; i <= 5; i += 1) await publishedCourse({ title: `Layer Course ${i}` });
    await publishedCourse({ title: "Something else" });

    const everything = dataOf(await search(cookie, "q=layer&limit=24")).courses.map((c) => c.id);
    expect(everything).toHaveLength(5);
    const paged = await allPages(cookie, "q=layer&limit=2");
    expect(paged).toEqual(everything);
    expect(new Set(paged).size).toBe(5);
    expect(await allPages(cookie, "limit=4")).toHaveLength(6);
  });

  it("refuses bad filters, sizes and cursors", async () => {
    const { cookie } = await learner();
    for (let i = 1; i <= 3; i += 1) await publishedCourse({ title: `Feed Course ${i}` });

    for (const qs of [
      "category=cooking",
      "difficulty=expert",
      "limit=0",
      "limit=25",
      "limit=abc",
      "limit=-1",
      "limit=1.5",
    ]) {
      const res = await search(cookie, qs);
      expect(res.status, qs).toBe(400);
    }
    expect(fieldErrorsOf(await search(cookie, "category=cooking"))).toHaveProperty("category");
    expect(fieldErrorsOf(await search(cookie, "difficulty=expert"))).toHaveProperty("difficulty");
    expect(fieldErrorsOf(await search(cookie, "limit=25"))).toHaveProperty("limit");

    const garbage = await search(cookie, "cursor=not-a-cursor");
    expect(garbage.status).toBe(400);
    expect(errorOf(garbage)).toBe(BAD_CATALOG_CURSOR);
    expect((await search(cookie, `cursor=${"a".repeat(301)}`)).status).toBe(400);

    // a cursor only continues the search it came from
    const { nextCursor } = dataOf(await search(cookie, "q=feed&limit=1"));
    expect(nextCursor).toBeTruthy();
    const cursor = encodeURIComponent(nextCursor!);
    expect((await search(cookie, `q=feed&limit=1&cursor=${cursor}`)).status).toBe(200);
    expect((await search(cookie, `q=feed&limit=2&cursor=${cursor}`)).status).toBe(200); // size isn't part of the search
    for (const other of ["q=course", "category=biosecurity", "difficulty=beginner", ""]) {
      const res = await search(cookie, `${other}&limit=1&cursor=${cursor}`);
      expect(res.status, other).toBe(400);
      expect(errorOf(res)).toBe(BAD_CATALOG_CURSOR);
    }
    // a tampered cursor is refused
    const [payload, signature] = nextCursor!.split(".");
    const flipped = `${payload}.${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect((await search(cookie, `q=feed&limit=1&cursor=${encodeURIComponent(flipped)}`)).status).toBe(400);
  });

  it("shows missing or no-longer-valid media as unavailable instead of passing it on", async () => {
    const { cookie } = await learner();
    const course = await publishedCourse({ coverUrl: "" });
    const [first, second] = lessonIds(course);
    expect(dataOf(await search(cookie)).courses[0].coverUrl).toBeNull();

    // stored references that no longer pass the checks (as if edited in the database)
    const { courses } = await trainingCollections();
    await courses.updateOne(
      { _id: new ObjectId(course.id) },
      {
        $set: {
          coverUrl: "https://evil.example.com/cover.jpg",
          "modules.0.lessons.0.videoUrl": "javascript:alert(1)",
          "modules.0.lessons.1.resources.0.url": "http://res.cloudinary.com/test-cloud/raw/upload/v1/guide.pdf",
        },
      },
    );
    expect(dataOf(await search(cookie)).courses[0].coverUrl).toBeNull();
    const outline = dataOf(await detail(cookie, course.id));
    expect(outline.coverUrl).toBeNull();
    expect(outline.modules[0].lessons.map((l) => [l.hasVideo, l.resourceCount])).toEqual([
      [false, 0],
      [true, 0],
    ]);
    const missing = dataOf(await viewLesson(cookie, course.id, first));
    expect(missing.lesson.videoUrl).toBeNull();
    const view = dataOf(await viewLesson(cookie, course.id, second));
    expect(view.lesson.videoUrl).toBe(VIDEO);
    expect(view.lesson.resources).toEqual([]);
  });

  it("features only published courses marked featured", async () => {
    const someone = await learner();
    const featured = await publishedCourse({ title: "Featured course", featured: true });
    await publishedCourse({ title: "Ordinary course" });
    await createDraft({ title: "Featured draft", featured: true });
    const home = await getTrainingHome(someone.userId);
    expect(home.featured.map((c) => c.id)).toEqual([featured.id]);
    expect(dataOf(await search(someone.cookie)).courses.find((c) => c.id === featured.id)?.featured).toBe(true);
  });
});

describe("Korret Academy progress", () => {
  it("enrols once however often Start is pressed, including at the same time", async () => {
    const me = await learner();
    const course = await publishedCourse();
    const first = await enroll(me.cookie, course.id);
    expect(first.status).toBe(200);
    expect(dataOf(first)).toEqual({ enrolled: true, resumeLessonId: lessonIds(course)[0] });
    await Promise.all([1, 2, 3, 4].map(() => enroll(me.cookie, course.id)));
    const { enrollments } = await trainingCollections();
    expect(await enrollments.countDocuments({ userId: me.userId })).toBe(1);
    expect(dataOf(await detail(me.cookie, course.id))).toMatchObject({ enrolled: true });

    expect((await enroll(me.cookie, course.id, { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await enroll("", course.id)).status).toBe(401);
  });

  it("keeps each learner's playback position to themselves", async () => {
    const me = await learner();
    const other = await learner();
    const course = await publishedCourse();
    const [lessonId, nextId] = lessonIds(course);

    const saved = await putPosition(me.cookie, course.id, lessonId, {
      positionSeconds: 125.7,
      userId: other.userId.toHexString(),
    });
    expect(saved.status).toBe(200);
    expect(dataOf(saved)).toEqual({ positionSeconds: 125 });
    expect(dataOf(await viewLesson(me.cookie, course.id, lessonId)).lesson.positionSeconds).toBe(125);
    expect(dataOf(await viewLesson(other.cookie, course.id, lessonId)).lesson.positionSeconds).toBe(0);

    // a position never completes a lesson, and Resume goes back to it
    expect(dataOf(await viewLesson(me.cookie, course.id, lessonId)).lesson.completed).toBe(false);
    await putPosition(me.cookie, course.id, nextId, { positionSeconds: 30 });
    expect(dataOf(await detail(me.cookie, course.id)).resumeLessonId).toBe(nextId);

    const { progress } = await trainingCollections();
    expect(await progress.countDocuments({ userId: me.userId })).toBe(2);
    expect(await progress.countDocuments({ userId: other.userId })).toBe(0);

    for (const body of [
      {},
      { positionSeconds: -1 },
      { positionSeconds: "60" },
      { positionSeconds: 13 * 3600 },
      { positionSeconds: null },
    ]) {
      expect((await putPosition(me.cookie, course.id, lessonId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await putPosition(me.cookie, course.id, "0123456789abcdef", { positionSeconds: 5 })).status).toBe(404);
    expect((await putPosition(me.cookie, course.id, "../../etc", { positionSeconds: 5 })).status).toBe(404);
    expect((await putPosition(me.cookie, course.id, lessonId, { positionSeconds: 5 }, { origin: null })).status).toBe(
      403,
    );
  });

  it("completes lessons idempotently and calculates progress from the records", async () => {
    const me = await learner();
    const other = await learner();
    const course = await publishedCourse();
    const [one, two, three] = lessonIds(course);

    const res = await complete(me.cookie, course.id, one, {
      percent: 100,
      completed: true,
      userId: other.userId.toHexString(),
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual({
      lessonId: one,
      completed: true,
      progress: { completedLessons: 1, totalLessons: 3, percent: 33, complete: false },
      nextLessonId: two,
    });
    const { progress, enrollments } = await trainingCollections();
    const firstAt = (await progress.findOne({ userId: me.userId, lessonId: one }))!.completedAt;

    // again, and several at once: still one record, same completion time
    await Promise.all([1, 2, 3].map(() => complete(me.cookie, course.id, one)));
    expect(await progress.countDocuments({ userId: me.userId, lessonId: one })).toBe(1);
    expect((await progress.findOne({ userId: me.userId, lessonId: one }))!.completedAt).toEqual(firstAt);
    expect(dataOf(await detail(me.cookie, course.id)).progress.completedLessons).toBe(1);

    // nobody else's progress moved
    expect(dataOf(await detail(other.cookie, course.id)).progress).toEqual({
      completedLessons: 0,
      totalLessons: 3,
      percent: 0,
      complete: false,
    });
    expect(await progress.countDocuments({ userId: other.userId })).toBe(0);

    await complete(me.cookie, course.id, two);
    const last = dataOf(await complete(me.cookie, course.id, three));
    expect(last.progress).toEqual({ completedLessons: 3, totalLessons: 3, percent: 100, complete: true });
    expect(last.nextLessonId).toBeNull();
    expect((await enrollments.findOne({ userId: me.userId }))!.completedAt).toBeInstanceOf(Date);
    const outline = dataOf(await detail(me.cookie, course.id));
    expect(outline.modules.flatMap((m) => m.lessons.map((l) => l.completed))).toEqual([true, true, true]);

    expect((await complete(me.cookie, course.id, "fedcba9876543210")).status).toBe(404);
    expect((await complete(me.cookie, course.id, one, {}, { origin: "https://evil.example.com" })).status).toBe(403);
  });

  it("lists unfinished courses under Continue Learning with where to resume", async () => {
    const me = await learner();
    const course = await publishedCourse();
    const [one, two, three] = lessonIds(course);
    await enroll(me.cookie, course.id);
    let home = await getTrainingHome(me.userId);
    expect(home.continueLearning.map((c) => [c.id, c.resumeLessonId, c.progress.percent])).toEqual([
      [course.id, one, 0],
    ]);

    await complete(me.cookie, course.id, one);
    home = await getTrainingHome(me.userId);
    expect(home.continueLearning[0]).toMatchObject({ resumeLessonId: two, progress: { completedLessons: 1 } });

    await complete(me.cookie, course.id, two);
    await complete(me.cookie, course.id, three);
    expect((await getTrainingHome(me.userId)).continueLearning).toEqual([]);
    expect((await getTrainingHome((await learner()).userId)).continueLearning).toEqual([]);
  });

  it("recalculates progress against the current curriculum after an edit", async () => {
    const me = await learner();
    const course = await publishedCourse();
    const [one, two, three] = lessonIds(course);
    await complete(me.cookie, course.id, one);
    await complete(me.cookie, course.id, two);

    // drop lesson two, add a new lesson; the others keep their ids
    const input = asInput(course);
    input.modules = [
      { ...input.modules[0], lessons: [input.modules[0].lessons[0]] },
      { ...input.modules[1], lessons: [...input.modules[1].lessons, lessonInput("Lesson four")] },
    ];
    const res = await putCourse(course.id, input);
    expect(res.status).toBe(200);
    const edited = dataOf(res).course;
    expect(lessonIds(edited).slice(0, 2)).toEqual([one, three]);
    expect(lessonIds(edited)).toHaveLength(3);
    expect(edited.status).toBe("published");

    const outline = dataOf(await detail(me.cookie, course.id));
    expect(outline.progress).toEqual({ completedLessons: 1, totalLessons: 3, percent: 33, complete: false });
    expect((await viewLesson(me.cookie, course.id, two)).status).toBe(404);
    expect((await complete(me.cookie, course.id, two)).status).toBe(404);
    // the old record is kept, it just doesn't count
    const { progress } = await trainingCollections();
    expect(await progress.countDocuments({ userId: me.userId })).toBe(2);
  });

  it("keeps a learner's records when a course is unpublished and restores them on republish", async () => {
    const me = await learner();
    const course = await publishedCourse();
    const [one] = lessonIds(course);
    await complete(me.cookie, course.id, one);

    const draft = await setStatus(course, "unpublish");
    expect((await detail(me.cookie, course.id)).status).toBe(404);
    expect((await viewLesson(me.cookie, course.id, one)).status).toBe(404);
    expect((await getTrainingHome(me.userId)).continueLearning).toEqual([]);

    await setStatus(draft, "publish");
    expect(dataOf(await detail(me.cookie, course.id)).progress.completedLessons).toBe(1);
  });
});

describe("Korret Academy admin", () => {
  it("is only for allowlisted admins", async () => {
    const someone = await learner();
    const course = await createDraft();
    vi.stubEnv("ADMIN_USER_IDS", "");
    admin = null;

    const created = await call(createCourseRoute, "/api/admin/training/courses", {
      body: courseBody(),
      cookie: someone.cookie,
    });
    expect(created.status).toBe(404);
    expect((await call(adminListRoute, "/api/admin/training/courses", { cookie: someone.cookie })).status).toBe(404);
    expect(
      (
        await callWith(
          adminCourseRoute,
          `/api/admin/training/courses/${course.id}`,
          { id: course.id },
          { cookie: someone.cookie },
        )
      ).status,
    ).toBe(404);
    expect((await putCourse(course.id, asInput(course), someone.cookie)).status).toBe(404);
    expect((await changeStatus(course, "publish", someone.cookie)).status).toBe(404);
    expect((await call(createCourseRoute, "/api/admin/training/courses", { body: courseBody() })).status).toBe(401);

    const { courses } = await trainingCollections();
    expect(await courses.countDocuments()).toBe(1);
    expect((await courses.findOne())!.status).toBe("draft");
  });

  it("saves new courses as drafts whatever the form claims", async () => {
    const course = await createDraft({ status: "published", publishedAt: "2030-01-01T00:00:00.000Z", _id: "x" });
    expect(course.status).toBe("draft");
    expect(course.publishedAt).toBeNull();
    expect(lessonIds(course).every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
    const page = dataOf(
      await call<AdminCoursePage>(adminListRoute, "/api/admin/training/courses", { cookie: admin!.cookie }),
    );
    expect(page.courses.map((c) => [c.id, c.status])).toEqual([[course.id, "draft"]]);
  });

  it("validates course details and media references", async () => {
    const { cookie } = await adminAccount();
    const post = (body: object) => call(createCourseRoute, "/api/admin/training/courses", { body, cookie });

    const bad = await post(
      courseBody({
        title: "",
        category: "cooking",
        difficulty: "",
        coverUrl: "https://evil.example.com/cover.jpg",
        modules: [
          {
            title: "Module",
            lessons: [
              lessonInput("One", { videoUrl: "javascript:alert(1)" }),
              lessonInput("Two", {
                videoUrl: "https://res.cloudinary.com/other-cloud/video/upload/v1/a.mp4",
                durationMinutes: 0,
              }),
              lessonInput("Three", {
                resources: [{ title: "Notes", url: "https://res.cloudinary.com/test-cloud/raw/upload/v1/a.exe" }],
              }),
            ],
          },
        ],
      }),
    );
    expect(bad.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(bad)).sort()).toEqual(
      [
        "title",
        "category",
        "difficulty",
        "coverUrl",
        "modules.0.lessons.0.videoUrl",
        "modules.0.lessons.1.videoUrl",
        "modules.0.lessons.1.durationMinutes",
        "modules.0.lessons.2.resources.0.url",
      ].sort(),
    );
    for (const url of [
      `${VIDEO}?x=1`,
      `${VIDEO}#t=1`,
      "https://res.cloudinary.com/test-cloud/video/upload/v1/%2e%2e/a.mp4",
      "http://res.cloudinary.com/test-cloud/video/upload/v1/a.mp4",
      "https://user:pw@res.cloudinary.com/test-cloud/video/upload/v1/a.mp4",
    ]) {
      const res = await post(
        courseBody({ modules: [{ title: "Module", lessons: [lessonInput("One", { videoUrl: url })] }] }),
      );
      expect(res.status, url).toBe(400);
    }
    const { courses } = await trainingCollections();
    expect(await courses.countDocuments()).toBe(0);
  });

  it("refuses ids it didn't issue, stale versions and incomplete published courses", async () => {
    const course = await createDraft();
    const input = asInput(course);

    const forged = await putCourse(course.id, {
      ...input,
      modules: [{ ...input.modules[0], lessons: [{ ...input.modules[0].lessons[0], id: "0123456789abcdef" }] }],
    });
    expect(forged.status).toBe(400);
    expect(fieldErrorsOf(forged)).toHaveProperty("modules.0.lessons.0.id");
    const duplicated = await putCourse(course.id, {
      ...input,
      modules: [{ ...input.modules[0], lessons: [input.modules[0].lessons[0], input.modules[0].lessons[0]] }],
    });
    expect(duplicated.status).toBe(400);

    const saved = dataOf(await putCourse(course.id, { ...input, title: "Broiler Health Basics, revised" })).course;
    expect(saved.title).toBe("Broiler Health Basics, revised");
    expect(lessonIds(saved)).toEqual(lessonIds(course));
    expect((await putCourse(course.id, input)).status).toBe(409); // the old version
    expect((await putCourse(course.id, { ...input, updatedAt: undefined })).status).toBe(409);
    expect((await changeStatus(course, "publish")).status).toBe(409);

    // a draft can be saved without videos, but can't be published like that
    const noVideo = asInput(saved);
    noVideo.modules[1].lessons[0].videoUrl = "";
    const incomplete = dataOf(await putCourse(course.id, noVideo)).course;
    expect(incomplete.publishIssues).toEqual(["Add a video to every lesson (1 missing)."]);
    const refused = await changeStatus(incomplete, "publish");
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toContain("Add a video to every lesson");

    // a published course has to stay publishable
    const fixed = dataOf(
      await putCourse(course.id, { ...asInput(incomplete), modules: asInput(saved).modules }),
    ).course;
    const live = await setStatus(fixed, "publish");
    const broken = asInput(live);
    broken.modules[0].lessons[0].videoUrl = "";
    expect((await putCourse(course.id, broken)).status).toBe(400);
    expect((await changeStatus(live, "publish")).status).toBe(409);
    expect((await putCourse(new ObjectId().toHexString(), input)).status).toBe(404);
  });

  it("audits every change", async () => {
    const course = await createDraft();
    const edited = dataOf(await putCourse(course.id, { ...asInput(course), title: "Broiler Health, edited" })).course;
    const live = await setStatus(edited, "publish");
    await setStatus(live, "unpublish");

    const audit = (await getDb()).collection<AdminAuditDoc>(COLLECTIONS.adminAudit);
    const records = await audit.find({ "target.id": course.id }).sort({ at: 1, _id: 1 }).toArray();
    expect(records.map((r) => [r.action, r.from, r.to])).toEqual([
      ["course.create", null, "draft"],
      ["course.update", null, null],
      ["course.publish", "draft", "published"],
      ["course.unpublish", "published", "draft"],
    ]);
    expect(records.every((r) => r.actorUserId?.equals(admin!.userId))).toBe(true);
  });
});

describe("Staff training", () => {
  it("needs the owner's own farm", async () => {
    const someone = await learner();
    const course = await publishedCourse();
    expect((await overview(someone.cookie)).status).toBe(403);
    expect((await invite(someone.cookie, { phone: newRegistration().phone, role: "farm-attendant" })).status).toBe(403);
    expect((await setProgram(someone.cookie, "farm-attendant", [course.id])).status).toBe(403);
    expect((await overview("")).status).toBe(401);
  });

  it("invites by phone, and shows nothing about a person until they accept", async () => {
    const farm = await owner();
    const course = await publishedCourse();
    const [one, two] = lessonIds(course);
    expect(dataOf(await setProgram(farm.cookie, "farm-attendant", [course.id])).program.courses).toEqual([
      { id: course.id, title: course.title, lessonCount: 3 },
    ]);

    const worker = await learner();
    const member = await invited(farm, worker.phone);
    expect(member).toMatchObject({ status: "invited", role: "farm-attendant", name: null, progress: [] });
    expect(member.phoneMasked).toBe(`+234******${worker.phone.slice(-4)}`);

    // the worker trains before accepting: the owner can't see it
    await complete(worker.cookie, course.id, one);
    let members = dataOf(await overview(farm.cookie)).members;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ status: "invited", name: null, progress: [], acceptedAt: null });
    expect(await myAssignments((await userByPhone(worker.phone))!)).toEqual([]);

    const list = dataOf(
      await call<{ invitations: StaffInvitation[] }>(invitationsRoute, "/api/training/invitations", {
        cookie: worker.cookie,
      }),
    );
    expect(list.invitations).toEqual([
      { id: member.id, farmName: "Alao Poultry Enterprises", role: "farm-attendant", invitedAt: member.invitedAt },
    ]);
    expect((await respond(worker.cookie, member.id, "maybe")).status).toBe(400);
    expect(dataOf(await respond(worker.cookie, member.id, "accept"))).toEqual({ status: "active" });
    expect((await respond(worker.cookie, member.id, "accept")).status).toBe(404); // already answered

    await complete(worker.cookie, course.id, two);
    members = dataOf(await overview(farm.cookie)).members;
    expect(members[0]).toMatchObject({ status: "active", name: "Adaeze Okafor" });
    expect(members[0].progress).toEqual([
      { courseId: course.id, title: course.title, completedLessons: 2, totalLessons: 3 },
    ]);
    // the summary matches the worker's own records
    const { progress } = await trainingCollections();
    expect(
      await progress.countDocuments({
        userId: worker.userId,
        courseId: new ObjectId(course.id),
        completedAt: { $ne: null },
      }),
    ).toBe(2);
    expect(dataOf(await detail(worker.cookie, course.id)).progress.completedLessons).toBe(2);

    const [assignment] = await myAssignments((await userByPhone(worker.phone))!);
    expect(assignment).toMatchObject({
      membershipId: member.id,
      farmName: "Alao Poultry Enterprises",
      role: "farm-attendant",
    });
    expect(assignment.courses.map((c) => [c.id, c.progress.completedLessons])).toEqual([[course.id, 2]]);

    // the owner can't see more than the current curriculum
    const input = asInput(course);
    input.modules = [input.modules[1]];
    expect((await putCourse(course.id, input)).status).toBe(200);
    expect(dataOf(await overview(farm.cookie)).members[0].progress).toEqual([
      { courseId: course.id, title: course.title, completedLessons: 0, totalLessons: 1 },
    ]);
  });

  it("only lets the invited phone number accept", async () => {
    const farm = await owner();
    const worker = await learner();
    const stranger = await learner();
    const member = await invited(farm, worker.phone);

    expect((await respond(stranger.cookie, member.id, "accept")).status).toBe(404);
    expect((await respond(farm.cookie, member.id, "accept")).status).toBe(404);
    expect((await respond(stranger.cookie, "not-an-id", "accept")).status).toBe(404);
    expect((await respond(worker.cookie, new ObjectId().toHexString(), "accept")).status).toBe(404);
    const list = dataOf(
      await call<{ invitations: StaffInvitation[] }>(invitationsRoute, "/api/training/invitations", {
        cookie: stranger.cookie,
      }),
    );
    expect(list.invitations).toEqual([]);
    expect(dataOf(await overview(farm.cookie)).members[0].status).toBe("invited");

    // declining closes it; the owner may invite again
    expect(dataOf(await respond(worker.cookie, member.id, "decline"))).toEqual({ status: "declined" });
    expect(dataOf(await overview(farm.cookie)).members).toEqual([]);
    expect((await respond(worker.cookie, member.id, "accept")).status).toBe(404);
    await invited(farm, worker.phone);
  });

  it("validates invitations and refuses forged roles", async () => {
    const farm = await owner();
    const worker = await learner();
    for (const body of [
      { phone: "12345", role: "farm-attendant" },
      { phone: farm.phone, role: "farm-attendant" },
      { phone: worker.phone, role: "admin" },
      { phone: worker.phone, role: "owner" },
      { phone: worker.phone },
    ]) {
      expect((await invite(farm.cookie, body)).status, JSON.stringify(body)).toBe(400);
    }
    const member = await invited(farm, worker.phone, "egg-handler");
    const again = await invite(farm.cookie, { phone: worker.phone, role: "farm-manager" });
    expect(again.status).toBe(409);

    expect((await patchMember(farm.cookie, member.id, { role: "admin" })).status).toBe(400);
    expect((await patchMember(farm.cookie, member.id, { role: "hatchery-operator" })).status).toBe(200);
    expect(dataOf(await overview(farm.cookie)).members[0].role).toBe("hatchery-operator");
    expect((await patchMember(farm.cookie, "nope", { role: "farm-manager" })).status).toBe(404);
  });

  it("assigns only published courses to a real role", async () => {
    const farm = await owner();
    const live = await publishedCourse();
    const draft = await createDraft();
    expect((await setProgram(farm.cookie, "admin", [live.id])).status).toBe(404);
    for (const ids of [
      [draft.id],
      ["not-an-id"],
      [live.id, live.id],
      "x",
      Array.from({ length: 13 }, () => new ObjectId().toHexString()),
    ]) {
      expect((await setProgram(farm.cookie, "farm-manager", ids)).status, JSON.stringify(ids)).toBe(400);
    }
    expect(dataOf(await setProgram(farm.cookie, "farm-manager", [live.id])).program.courses).toHaveLength(1);
    expect(dataOf(await setProgram(farm.cookie, "farm-manager", [])).program.courses).toEqual([]);

    // an unpublished course drops out of the programme
    await setProgram(farm.cookie, "farm-manager", [live.id]);
    await setStatus(live, "unpublish");
    const programs = dataOf(await overview(farm.cookie)).programs;
    expect(programs.map((p) => p.role)).toEqual(["farm-attendant", "farm-manager", "egg-handler", "hatchery-operator"]);
    expect(programs.every((p) => p.courses.length === 0)).toBe(true);
  });

  it("keeps each farm's staff and programmes to its owner", async () => {
    const farmA = await owner();
    const farmB = await owner();
    const course = await publishedCourse();
    const worker = await learner();
    const member = await invited(farmA, worker.phone);
    await respond(worker.cookie, member.id, "accept");
    await setProgram(farmA.cookie, "farm-attendant", [course.id]);

    // another owner can't see, change or remove farm A's people
    expect(dataOf(await overview(farmB.cookie)).members).toEqual([]);
    expect(dataOf(await overview(farmB.cookie)).programs.every((p) => p.courses.length === 0)).toBe(true);
    expect((await patchMember(farmB.cookie, member.id, { role: "farm-manager" })).status).toBe(404);
    expect((await removeMember(farmB.cookie, member.id)).status).toBe(404);
    expect((await patchMember(worker.cookie, member.id, { role: "farm-manager" })).status).toBe(403);

    // a farm id in the body is ignored: invitations always go to the caller's farm
    const { farms, staff } = await trainingCollections();
    const farmADoc = (await farms.findOne({ ownerUserId: farmA.userId }))!;
    const farmBDoc = (await farms.findOne({ ownerUserId: farmB.userId }))!;
    const other = await learner();
    const res = await invite(farmB.cookie, {
      phone: other.phone,
      role: "farm-attendant",
      farmId: farmADoc._id.toHexString(),
    });
    expect(res.status).toBe(201);
    expect((await staff.findOne({ phoneNormalized: other.phone }))!.farmId.equals(farmBDoc._id)).toBe(true);
    expect(dataOf(await overview(farmA.cookie)).members.map((m) => m.id)).toEqual([member.id]);

    // the owner removes the member: their assignment ends, their own progress stays
    await complete(worker.cookie, course.id, lessonIds(course)[0]);
    expect((await removeMember(farmA.cookie, member.id)).status).toBe(200);
    expect(dataOf(await overview(farmA.cookie)).members).toEqual([]);
    expect(await myAssignments((await userByPhone(worker.phone))!)).toEqual([]);
    expect(dataOf(await detail(worker.cookie, course.id)).progress.completedLessons).toBe(1);
    expect((await removeMember(farmA.cookie, member.id)).status).toBe(404);
  });
});
