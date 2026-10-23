import { request } from "@/lib/auth/api";
import type {
  CredentialCaseResponse,
  CredentialDecisionRequest,
  CloseIssueRequest,
  IssueCaseResponse,
  ModerationRequest,
  ModerationResponse,
} from "./types";
import type {
  AccountDetail,
  AccountLookupResponse,
  AccountStatusRequest,
  ChangeRoleRequest,
  GrantRoleRequest,
  TeamLookupResponse,
  TeamMemberDetail,
} from "./accounts";
import type { CaseChangeRequest, CaseResponse, CreateCaseRequest } from "./cases";

// Browser-side calls for admin actions. The session cookie is the only thing
// that identifies the admin; no user id, role or flag is ever sent, and the
// server re-checks the admin's role on every call. Pages read their data on the
// server, so only the actions live here.

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const decideCredential = (userId: string, body: CredentialDecisionRequest) =>
  post<CredentialCaseResponse>(`/api/admin/credentials/${encodeURIComponent(userId)}`, body);

export const closeIssue = (orderNumber: string, body: CloseIssueRequest) =>
  post<IssueCaseResponse>(`/api/admin/issues/${encodeURIComponent(orderNumber)}`, body);

export const moderateReview = (reviewId: string, body: ModerationRequest) =>
  post<ModerationResponse>(`/api/admin/reviews/${encodeURIComponent(reviewId)}`, body);

// lookups are POSTs so a phone number or email never sits in a URL
export const lookupAccount = (q: string) => post<AccountLookupResponse>("/api/admin/users/lookup", { q });

export const changeAccountStatus = (userId: string, body: AccountStatusRequest) =>
  post<AccountDetail>(`/api/admin/users/${encodeURIComponent(userId)}/status`, body);

export const lookupTeamCandidate = (q: string) => post<TeamLookupResponse>("/api/admin/team/lookup", { q });

export const grantRole = (body: GrantRoleRequest) => post<TeamMemberDetail>("/api/admin/team", body);

export const changeRole = (userId: string, body: ChangeRoleRequest) =>
  post<TeamMemberDetail>(`/api/admin/team/${encodeURIComponent(userId)}`, body);

export const createCase = (body: CreateCaseRequest) => post<CaseResponse>("/api/admin/cases", body);

export const changeCase = (reference: string, body: CaseChangeRequest) =>
  post<CaseResponse>(`/api/admin/cases/${encodeURIComponent(reference)}`, body);
