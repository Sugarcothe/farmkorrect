import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import { maskPhone, normalizePhone } from "@/lib/auth/validation";
import {
  isStaffRole,
  STAFF_ROLES,
  TRAINING_LIMITS,
  type InvitationDecision,
  type MyAssignment,
  type ProgramCourse,
  type StaffInvitation,
  type StaffMember,
  type StaffOverview,
  type StaffProgram,
  type StaffRole,
} from "@/lib/training/types";
import { HttpError } from "./http";
import type { CourseDoc, FarmDoc, FarmStaffDoc, UserDoc } from "./models";
import { completedLessonIds, flattenLessons, parseObjectId, progressOf, toCard, trainingCollections } from "./training";

// Staff training. A farm owner invites people by phone number and assigns
// each staff role a programme of published courses. Nobody becomes staff by
// being invited: the invitee has to accept while signed in to an account
// whose verified phone number is the one invited. The farm is always the
// signed-in owner's own (looked up from the session, never sent by the
// browser), and the owner sees training progress only for people who have
// accepted. Records are never deleted: removing or declining closes them.

export const NO_FARM = "Set up your farm profile before adding staff.";
export const STAFF_NOT_FOUND = "We couldn't find that staff member.";
export const INVITATION_NOT_FOUND = "We couldn't find that invitation. It may have been withdrawn.";

/** The signed-in owner's farm, or a 403. */
export async function requireOwnFarm(user: UserDoc): Promise<FarmDoc> {
  const { farms } = await trainingCollections();
  const farm = await farms.findOne({ ownerUserId: user._id, initialProfile: true });
  if (!farm) throw new HttpError(403, NO_FARM);
  return farm;
}

/** The owner's farm when they have one, for pages deciding what to show. */
export async function findOwnFarm(user: UserDoc): Promise<FarmDoc | null> {
  return (await trainingCollections()).farms.findOne({ ownerUserId: user._id, initialProfile: true });
}

function parseRole(value: unknown): StaffRole {
  if (!isStaffRole(value)) throw new HttpError(400, "Choose a staff role.", { role: "Choose a staff role." });
  return value;
}

/** Published courses by id, in the order given; anything else is left out. */
async function publishedByIds(ids: ObjectId[]): Promise<CourseDoc[]> {
  if (ids.length === 0) return [];
  const { courses } = await trainingCollections();
  const docs = await courses
    .find({ _id: { $in: ids }, status: "published" })
    .limit(ids.length)
    .toArray();
  const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
  return ids.flatMap((id) => byId.get(id.toHexString()) ?? []);
}

async function farmPrograms(farmId: ObjectId): Promise<{ programs: StaffProgram[]; courses: Map<string, CourseDoc> }> {
  const { programs } = await trainingCollections();
  const docs = await programs.find({ farmId }).limit(STAFF_ROLES.length).toArray();
  const courses = await publishedByIds([
    ...new Map(docs.flatMap((d) => d.courseIds).map((id) => [id.toHexString(), id])).values(),
  ]);
  const byId = new Map(courses.map((c) => [c._id.toHexString(), c]));
  return {
    programs: STAFF_ROLES.map(({ value: role }) => {
      const doc = docs.find((d) => d.role === role);
      return {
        role,
        courses: (doc?.courseIds ?? []).flatMap((id) => {
          const c = byId.get(id.toHexString());
          return c ? [{ id: c._id.toHexString(), title: c.title, lessonCount: c.lessonCount }] : [];
        }),
      };
    }),
    courses: byId,
  };
}

/**
 * Completed lessons of the current curriculum per (member, course), counted
 * by the database: one grouped query however many members there are.
 */
async function completionCounts(userIds: ObjectId[], courses: CourseDoc[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0 || courses.length === 0) return out;
  const lessonIds = courses.flatMap((c) => flattenLessons(c).map((l) => l.lesson.id));
  const { progress } = await trainingCollections();
  const rows = await progress
    .aggregate<{ _id: { u: ObjectId; c: ObjectId }; n: number }>([
      {
        $match: {
          userId: { $in: userIds },
          courseId: { $in: courses.map((c) => c._id) },
          lessonId: { $in: lessonIds },
          completedAt: { $ne: null },
        },
      },
      { $group: { _id: { u: "$userId", c: "$courseId" }, n: { $sum: 1 } } },
    ])
    .toArray();
  for (const r of rows) out.set(`${r._id.u.toHexString()}:${r._id.c.toHexString()}`, r.n);
  return out;
}

function toMember(
  doc: FarmStaffDoc,
  names: Map<string, string>,
  program: StaffProgram | undefined,
  courses: Map<string, CourseDoc>,
  counts: Map<string, number>,
): StaffMember {
  const active = doc.status === "active" && doc.userId !== null;
  return {
    id: doc._id.toHexString(),
    role: doc.role,
    status: active ? "active" : "invited",
    name: active ? (names.get(doc.userId!.toHexString()) ?? null) : null,
    phoneMasked: maskPhone(doc.phoneNormalized),
    invitedAt: doc.invitedAt.toISOString(),
    acceptedAt: active ? (doc.respondedAt?.toISOString() ?? null) : null,
    progress: active
      ? (program?.courses ?? []).map((pc) => {
          const course = courses.get(pc.id)!;
          // a member can't have completed more lessons than the curriculum has now
          const total = flattenLessons(course).length;
          return {
            courseId: pc.id,
            title: pc.title,
            completedLessons: Math.min(total, counts.get(`${doc.userId!.toHexString()}:${pc.id}`) ?? 0),
            totalLessons: total,
          };
        })
      : [],
  };
}

/** The owner's Staff Training page: programmes per role and everyone invited or on staff. */
export async function getStaffOverview(owner: UserDoc): Promise<StaffOverview> {
  const farm = await requireOwnFarm(owner);
  const { staff, users } = await trainingCollections();
  const [docs, { programs, courses }] = await Promise.all([
    staff.find({ farmId: farm._id, open: true }).sort({ invitedAt: -1 }).limit(TRAINING_LIMITS.staffPerFarm).toArray(),
    farmPrograms(farm._id),
  ]);
  const memberIds = docs.filter((d) => d.status === "active" && d.userId).map((d) => d.userId!);
  const [people, counts] = await Promise.all([
    users
      .find({ _id: { $in: memberIds } }, { projection: { fullName: 1 } })
      .limit(memberIds.length)
      .toArray(),
    completionCounts(memberIds, [...courses.values()]),
  ]);
  const names = new Map(people.map((p) => [p._id.toHexString(), p.fullName]));
  return {
    farmName: farm.farmName,
    programs,
    members: docs.map((d) =>
      toMember(
        d,
        names,
        programs.find((p) => p.role === d.role),
        courses,
        counts,
      ),
    ),
  };
}

/** Invites a phone number to the owner's farm in a staff role. */
export async function inviteStaff(owner: UserDoc, body: Record<string, unknown>): Promise<StaffMember> {
  const farm = await requireOwnFarm(owner);
  const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
  const fieldErrors: Record<string, string> = {};
  if (!phone) fieldErrors.phone = "Enter a valid Nigerian mobile number, e.g. 0812 345 6789.";
  else if (phone === owner.phoneNormalized) fieldErrors.phone = "That's your own number.";
  if (!isStaffRole(body.role)) fieldErrors.role = "Choose a staff role.";
  if (Object.keys(fieldErrors).length) throw new HttpError(400, "Please check the invitation.", fieldErrors);

  const { staff } = await trainingCollections();
  if ((await staff.countDocuments({ farmId: farm._id, open: true })) >= TRAINING_LIMITS.staffPerFarm)
    throw new HttpError(409, `A farm can have at most ${TRAINING_LIMITS.staffPerFarm} staff and invitations.`);
  const now = new Date();
  const doc: FarmStaffDoc = {
    _id: new ObjectId(),
    farmId: farm._id,
    ownerUserId: owner._id,
    phoneNormalized: phone!,
    role: body.role as StaffRole,
    status: "invited",
    open: true,
    userId: null,
    invitedAt: now,
    respondedAt: null,
    removedAt: null,
    updatedAt: now,
  };
  try {
    await staff.insertOne(doc);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000)
      throw new HttpError(409, "That number already has an invitation or is on your staff.", {
        phone: "Already invited or on your staff.",
      });
    throw error;
  }
  return toMember(doc, new Map(), undefined, new Map(), new Map());
}

async function ownMember(owner: UserDoc, id: string) {
  const farm = await requireOwnFarm(owner);
  const _id = parseObjectId(id);
  if (!_id) throw new HttpError(404, STAFF_NOT_FOUND);
  return { farm, _id };
}

/** Moves an invited or active member to another role on the owner's own farm. */
export async function changeStaffRole(owner: UserDoc, id: string, body: Record<string, unknown>): Promise<void> {
  const { farm, _id } = await ownMember(owner, id);
  const role = parseRole(body.role);
  const { staff } = await trainingCollections();
  const result = await staff.updateOne(
    { _id, farmId: farm._id, open: true },
    { $set: { role, updatedAt: new Date() } },
  );
  if (result.matchedCount === 0) throw new HttpError(404, STAFF_NOT_FOUND);
}

/** Withdraws an invitation or removes a member. Their own training progress is theirs and is kept. */
export async function removeStaff(owner: UserDoc, id: string): Promise<void> {
  const { farm, _id } = await ownMember(owner, id);
  const { staff } = await trainingCollections();
  const now = new Date();
  const result = await staff.updateOne(
    { _id, farmId: farm._id, open: true },
    { $set: { status: "removed", removedAt: now, updatedAt: now }, $unset: { open: "" } },
  );
  if (result.matchedCount === 0) throw new HttpError(404, STAFF_NOT_FOUND);
}

/** published courses offered when choosing a programme (newest first) */
export const PROGRAM_OPTION_LIMIT = 100;

/** Published courses an owner can choose from for a programme, by title. Bounded. */
export async function programCourseOptions(): Promise<ProgramCourse[]> {
  const { courses } = await trainingCollections();
  const docs = await courses
    .find({ status: "published" }, { projection: { title: 1, lessonCount: 1 } })
    .sort({ publishedAt: -1, _id: -1 })
    .limit(PROGRAM_OPTION_LIMIT)
    .toArray();
  return docs
    .map((c) => ({ id: c._id.toHexString(), title: c.title, lessonCount: c.lessonCount }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Sets the published courses for one role on the owner's farm (an empty list clears it). */
export async function setProgram(
  owner: UserDoc,
  roleParam: string,
  body: Record<string, unknown>,
): Promise<StaffProgram> {
  const farm = await requireOwnFarm(owner);
  if (!isStaffRole(roleParam)) throw new HttpError(404, "We couldn't find that staff role.");
  const raw = body.courseIds;
  const invalid = () =>
    new HttpError(400, "Please check the courses.", {
      courseIds: `Choose up to ${TRAINING_LIMITS.programCourses} published courses.`,
    });
  if (!Array.isArray(raw) || raw.length > TRAINING_LIMITS.programCourses) throw invalid();
  const ids = raw.map(parseObjectId);
  if (ids.some((id) => id === null) || new Set(raw).size !== raw.length) throw invalid();
  const courses = await publishedByIds(ids as ObjectId[]);
  if (courses.length !== ids.length)
    throw new HttpError(400, "Some of those courses aren't available.", {
      courseIds: "Only published courses can be assigned.",
    });
  const { programs } = await trainingCollections();
  await programs.updateOne(
    { farmId: farm._id, role: roleParam },
    {
      $set: { courseIds: courses.map((c) => c._id), updatedBy: owner._id, updatedAt: new Date() },
      $setOnInsert: { _id: new ObjectId(), farmId: farm._id, role: roleParam },
    },
    { upsert: true },
  );
  return {
    role: roleParam,
    courses: courses.map((c) => ({ id: c._id.toHexString(), title: c.title, lessonCount: c.lessonCount })),
  };
}

// --- the invitee's side ----------------------------------------------------------------

const INVITATION_LIMIT = 20;

async function farmNames(farmIds: ObjectId[]): Promise<Map<string, string>> {
  const { farms } = await trainingCollections();
  const docs = await farms
    .find({ _id: { $in: farmIds } }, { projection: { farmName: 1 } })
    .limit(farmIds.length)
    .toArray();
  return new Map(docs.map((f) => [f._id.toHexString(), f.farmName]));
}

/** Open invitations to the signed-in user's own verified phone number. */
export async function listInvitations(user: UserDoc): Promise<StaffInvitation[]> {
  const { staff } = await trainingCollections();
  const docs = await staff
    .find({ phoneNormalized: user.phoneNormalized, status: "invited", ownerUserId: { $ne: user._id } })
    .sort({ invitedAt: -1 })
    .limit(INVITATION_LIMIT)
    .toArray();
  const names = await farmNames(docs.map((d) => d.farmId));
  return docs.flatMap((d) => {
    const farmName = names.get(d.farmId.toHexString());
    return farmName ? [{ id: d._id.toHexString(), farmName, role: d.role, invitedAt: d.invitedAt.toISOString() }] : [];
  });
}

export function parseDecision(body: Record<string, unknown>): InvitationDecision {
  const decision = body.decision;
  if (decision !== "accept" && decision !== "decline")
    throw new HttpError(400, "Choose accept or decline.", { decision: "Choose accept or decline." });
  return decision;
}

/**
 * Accepts or declines an invitation, only when it was sent to the signed-in
 * user's verified phone number. Anyone else's invitation is a 404.
 */
export async function respondToInvitation(user: UserDoc, id: string, decision: InvitationDecision) {
  const _id = parseObjectId(id);
  if (!_id) throw new HttpError(404, INVITATION_NOT_FOUND);
  const { staff } = await trainingCollections();
  const now = new Date();
  const result = await staff.updateOne(
    { _id, status: "invited", open: true, phoneNormalized: user.phoneNormalized, ownerUserId: { $ne: user._id } },
    decision === "accept"
      ? { $set: { status: "active", userId: user._id, respondedAt: now, updatedAt: now } }
      : { $set: { status: "declined", respondedAt: now, updatedAt: now }, $unset: { open: "" } },
  );
  if (result.matchedCount === 0) throw new HttpError(404, INVITATION_NOT_FOUND);
  return { status: decision === "accept" ? ("active" as const) : ("declined" as const) };
}

const MEMBERSHIP_LIMIT = 10;

/** Programmes assigned to the signed-in user by farms whose invitation they accepted. */
export async function myAssignments(user: UserDoc): Promise<MyAssignment[]> {
  const { staff, programs } = await trainingCollections();
  const memberships = await staff
    .find({ userId: user._id, status: "active", open: true })
    .sort({ respondedAt: -1 })
    .limit(MEMBERSHIP_LIMIT)
    .toArray();
  if (memberships.length === 0) return [];
  const [names, docs] = await Promise.all([
    farmNames(memberships.map((m) => m.farmId)),
    programs
      .find({ $or: memberships.map((m) => ({ farmId: m.farmId, role: m.role })) })
      .limit(memberships.length)
      .toArray(),
  ]);
  const courseIds = [...new Map(docs.flatMap((d) => d.courseIds).map((id) => [id.toHexString(), id])).values()];
  const [courses, done] = await Promise.all([publishedByIds(courseIds), completedLessonIds(user._id, courseIds)]);
  const byId = new Map(courses.map((c) => [c._id.toHexString(), c]));
  return memberships.flatMap((m) => {
    const farmName = names.get(m.farmId.toHexString());
    if (!farmName) return [];
    const program = docs.find((d) => d.farmId.equals(m.farmId) && d.role === m.role);
    return [
      {
        membershipId: m._id.toHexString(),
        farmName,
        role: m.role,
        courses: (program?.courseIds ?? []).flatMap((id) => {
          const c = byId.get(id.toHexString());
          return c ? [{ ...toCard(c), progress: progressOf(c, done.get(id.toHexString()) ?? new Set()) }] : [];
        }),
      },
    ];
  });
}
