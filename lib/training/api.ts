import { request } from "@/lib/auth/api";
import type {
  AdminCourseResponse,
  CompleteResponse,
  CourseInput,
  CourseStatusRequest,
  EnrollResponse,
  InvitationDecision,
  InvitationResponse,
  InviteRequest,
  PositionResponse,
  ProgramResponse,
  StaffMemberResponse,
  StaffRole,
} from "./types";

// Browser-side calls for Korret Academy. The session cookie identifies who is
// acting; no user id, farm id, progress figure, role permission or status is
// ever sent as proof of anything.

const json = (method: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

const course = (id: string) => `/api/training/courses/${encodeURIComponent(id)}`;
const lesson = (id: string, lessonId: string) => `${course(id)}/lessons/${encodeURIComponent(lessonId)}`;

export const enrollInCourse = (courseId: string) => request<EnrollResponse>(`${course(courseId)}/enroll`, json("POST"));

export const savePosition = (courseId: string, lessonId: string, positionSeconds: number, keepalive = false) =>
  request<PositionResponse>(`${lesson(courseId, lessonId)}/position`, {
    ...json("PUT", { positionSeconds }),
    keepalive,
  });

export const completeLesson = (courseId: string, lessonId: string) =>
  request<CompleteResponse>(`${lesson(courseId, lessonId)}/complete`, json("POST"));

// --- staff ------------------------------------------------------------------------

export const inviteStaff = (body: InviteRequest) =>
  request<StaffMemberResponse>("/api/training/staff", json("POST", body));

export const changeStaffRole = (id: string, role: StaffRole) =>
  request<{ updated: true }>(`/api/training/staff/${encodeURIComponent(id)}`, json("PATCH", { role }));

export const removeStaff = (id: string) =>
  request<{ removed: true }>(`/api/training/staff/${encodeURIComponent(id)}`, json("DELETE"));

export const saveProgram = (role: StaffRole, courseIds: string[]) =>
  request<ProgramResponse>(`/api/training/staff/programs/${encodeURIComponent(role)}`, json("PUT", { courseIds }));

export const respondToInvitation = (id: string, decision: InvitationDecision) =>
  request<InvitationResponse>(`/api/training/invitations/${encodeURIComponent(id)}`, json("POST", { decision }));

// --- admin ------------------------------------------------------------------------

export const createCourse = (body: CourseInput) =>
  request<AdminCourseResponse>("/api/admin/training/courses", json("POST", body));

export const updateCourse = (id: string, body: CourseInput) =>
  request<AdminCourseResponse>(`/api/admin/training/courses/${encodeURIComponent(id)}`, json("PUT", body));

export const changeCourseStatus = (id: string, body: CourseStatusRequest) =>
  request<AdminCourseResponse>(`/api/admin/training/courses/${encodeURIComponent(id)}/status`, json("POST", body));
