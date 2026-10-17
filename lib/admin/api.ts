import { request } from "@/lib/auth/api";
import type {
  CredentialCaseResponse,
  CredentialDecisionRequest,
  CloseIssueRequest,
  IssueCaseResponse,
  ModerationRequest,
  ModerationResponse,
} from "./types";

// Browser-side calls for admin actions. The session cookie is the only thing
// that identifies the admin; no user id, role or flag is ever sent, and the
// server re-checks the allowlist on every call. Pages read their data on the
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
