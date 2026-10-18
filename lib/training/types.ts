// Public shapes for Korret Academy (the `data` of an ApiResult), shared by the
// browser and the server. Every progress figure here is calculated on the
// server from the learner's own completion records against the course's
// current curriculum; nothing is stored as a percentage or taken from the
// browser. See docs/training-academy.md.

// --- configuration --------------------------------------------------------------

/** Course categories. Configurable: add a value here, it's validated everywhere. */
export const COURSE_CATEGORIES = [
  { value: "poultry-health", label: "Poultry health" },
  { value: "biosecurity", label: "Biosecurity" },
  { value: "feeding-nutrition", label: "Feeding & nutrition" },
  { value: "housing-equipment", label: "Housing & equipment" },
  { value: "egg-production", label: "Egg production" },
  { value: "hatchery", label: "Hatchery" },
  { value: "farm-business", label: "Farm business" },
] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number]["value"];

export const DIFFICULTIES = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
] as const;
export type Difficulty = (typeof DIFFICULTIES)[number]["value"];

/** Staff roles a farm can train for. Configurable categories, not permissions. */
export const STAFF_ROLES = [
  { value: "farm-attendant", label: "Farm Attendants", single: "Farm attendant" },
  { value: "farm-manager", label: "Farm Managers", single: "Farm manager" },
  { value: "egg-handler", label: "Egg Sorters/Handlers", single: "Egg sorter/handler" },
  { value: "hatchery-operator", label: "Hatchery Operators", single: "Hatchery operator" },
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number]["value"];

const has = <T extends string>(list: readonly { value: T }[], value: unknown): value is T =>
  typeof value === "string" && list.some((o) => o.value === value);

export const isCourseCategory = (v: unknown): v is CourseCategory => has(COURSE_CATEGORIES, v);
export const isDifficulty = (v: unknown): v is Difficulty => has(DIFFICULTIES, v);
export const isStaffRole = (v: unknown): v is StaffRole => has(STAFF_ROLES, v);

export const categoryLabel = (v: CourseCategory) => COURSE_CATEGORIES.find((c) => c.value === v)?.label ?? v;
export const difficultyLabel = (v: Difficulty) => DIFFICULTIES.find((d) => d.value === v)?.label ?? v;
export const staffRoleLabel = (v: StaffRole) => STAFF_ROLES.find((r) => r.value === v)?.label ?? v;
export const staffRoleSingle = (v: StaffRole) => STAFF_ROLES.find((r) => r.value === v)?.single ?? v;

export const TRAINING_LIMITS = {
  title: { min: 4, max: 120 },
  description: { min: 20, max: 4000 },
  instructor: { min: 2, max: 80 },
  listItems: 10,
  listItem: 200,
  modules: 20,
  lessonsPerModule: 40,
  lessons: 200,
  moduleTitle: { min: 2, max: 120 },
  lessonTitle: { min: 2, max: 120 },
  lessonSummary: 1000,
  /** minutes, as the admin enters them */
  lessonMinutes: { min: 1, max: 600 },
  resources: 5,
  resourceTitle: { min: 2, max: 80 },
  mediaUrl: 500,
  /** courses in one role's programme */
  programCourses: 12,
  /** open (invited or active) staff per farm */
  staffPerFarm: 50,
  /** a saved playback position can't be later than this */
  maxPositionSeconds: 12 * 60 * 60,
} as const;

export const CATALOG_PAGE_SIZE = 10;
export const CATALOG_MAX_PAGE_SIZE = 24;
export const SEARCH_LIMITS = { words: 5, wordMin: 2, max: 60 } as const;

// --- the catalogue ----------------------------------------------------------------

export type CatalogQuery = {
  /** free text over title, topic (category) and instructor */
  q: string;
  category: CourseCategory | null;
  difficulty: Difficulty | null;
};

/** A learner's progress through a course, from their completion records. */
export type CourseProgress = {
  completedLessons: number;
  totalLessons: number;
  /** completedLessons / totalLessons, rounded down */
  percent: number;
  /** every lesson of the current curriculum is complete */
  complete: boolean;
};

export type CourseCard = {
  id: string;
  title: string;
  instructor: string;
  category: CourseCategory;
  difficulty: Difficulty;
  lessonCount: number;
  durationSeconds: number;
  /** null when there is no cover or it can't be shown */
  coverUrl: string | null;
  featured: boolean;
};

export type CatalogPage = { courses: CourseCard[]; nextCursor: string | null };

export type ContinueItem = CourseCard & { progress: CourseProgress; resumeLessonId: string | null };

export type TrainingHome = {
  continueLearning: ContinueItem[];
  featured: CourseCard[];
};

// --- a course -------------------------------------------------------------------

export type LessonOutline = {
  id: string;
  title: string;
  durationSeconds: number;
  completed: boolean;
  /** false when the lesson's video can't be played right now */
  hasVideo: boolean;
  resourceCount: number;
};

export type ModuleOutline = { id: string; title: string; lessons: LessonOutline[] };

export type CourseDetail = CourseCard & {
  description: string;
  objectives: string[];
  prerequisites: string[];
  modules: ModuleOutline[];
  enrolled: boolean;
  progress: CourseProgress;
  /** where Start/Resume goes: the last lesson worked on, else the first unfinished one */
  resumeLessonId: string | null;
};

export type LessonResource = { id: string; title: string; url: string };

export type LessonView = {
  course: { id: string; title: string };
  module: { id: string; title: string; index: number };
  lesson: {
    id: string;
    title: string;
    summary: string;
    durationSeconds: number;
    /** null: the video is missing or can't be played right now */
    videoUrl: string | null;
    resources: LessonResource[];
    positionSeconds: number;
    completed: boolean;
  };
  previousLessonId: string | null;
  nextLessonId: string | null;
  /** the whole curriculum, for the lesson list */
  modules: ModuleOutline[];
  progress: CourseProgress;
};

export type EnrollResponse = { enrolled: true; resumeLessonId: string | null };
export type PositionRequest = { positionSeconds: number };
export type PositionResponse = { positionSeconds: number };
export type CompleteResponse = {
  lessonId: string;
  completed: true;
  progress: CourseProgress;
  nextLessonId: string | null;
};

// --- admin --------------------------------------------------------------------------

export type CourseStatus = "draft" | "published";

export type ResourceInput = { id?: string; title: string; url: string };
export type LessonInput = {
  id?: string;
  title: string;
  summary: string;
  durationMinutes: number;
  videoUrl: string;
  resources: ResourceInput[];
};
export type ModuleInput = { id?: string; title: string; lessons: LessonInput[] };

/** What the admin course form sends. Ids are only ever ones the server issued. */
export type CourseInput = {
  title: string;
  description: string;
  instructor: string;
  category: CourseCategory | "";
  difficulty: Difficulty | "";
  objectives: string[];
  prerequisites: string[];
  coverUrl: string;
  featured: boolean;
  modules: ModuleInput[];
  /** the version being edited (updates only); a newer one is refused as stale */
  updatedAt?: string;
};

export type AdminCourse = {
  id: string;
  status: CourseStatus;
  title: string;
  description: string;
  instructor: string;
  category: CourseCategory;
  difficulty: Difficulty;
  objectives: string[];
  prerequisites: string[];
  coverUrl: string | null;
  featured: boolean;
  modules: {
    id: string;
    title: string;
    lessons: {
      id: string;
      title: string;
      summary: string;
      durationMinutes: number;
      videoUrl: string | null;
      resources: { id: string; title: string; url: string }[];
    }[];
  }[];
  lessonCount: number;
  durationSeconds: number;
  /** why it can't be published yet; empty when it can */
  publishIssues: string[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminCourseRow = Pick<
  AdminCourse,
  "id" | "status" | "title" | "category" | "difficulty" | "featured" | "lessonCount" | "updatedAt"
>;

export type AdminCoursePage = { courses: AdminCourseRow[]; page: number; hasMore: boolean };
export type AdminCourseResponse = { course: AdminCourse };
export type CourseStatusRequest = { action: "publish" | "unpublish"; updatedAt: string };

// --- staff training -------------------------------------------------------------------

export type StaffStatus = "invited" | "active" | "declined" | "removed";

export type StaffCourseProgress = { courseId: string; title: string; completedLessons: number; totalLessons: number };

export type StaffMember = {
  id: string;
  role: StaffRole;
  status: "invited" | "active";
  /** the member's name, only once they've accepted */
  name: string | null;
  phoneMasked: string;
  invitedAt: string;
  acceptedAt: string | null;
  /** their programme's courses (active members only; empty while invited) */
  progress: StaffCourseProgress[];
};

export type ProgramCourse = { id: string; title: string; lessonCount: number };
export type StaffProgram = { role: StaffRole; courses: ProgramCourse[] };

export type StaffOverview = {
  farmName: string;
  programs: StaffProgram[];
  members: StaffMember[];
};

export type InviteRequest = { phone: string; role: StaffRole };
export type StaffMemberResponse = { member: StaffMember };
export type ProgramRequest = { courseIds: string[] };
export type ProgramResponse = { program: StaffProgram };

/** An invitation addressed to the signed-in user's verified phone number. */
export type StaffInvitation = { id: string; farmName: string; role: StaffRole; invitedAt: string };

/** A programme assigned to the signed-in user by a farm they've joined. */
export type MyAssignment = {
  membershipId: string;
  farmName: string;
  role: StaffRole;
  courses: (CourseCard & { progress: CourseProgress })[];
};

export type InvitationDecision = "accept" | "decline";
export type InvitationResponse = { status: "active" | "declined" };
