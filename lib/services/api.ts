import { request } from "@/lib/auth/api";
import type { ServiceCreateRequest, ServiceResponse, ServiceUpdateRequest } from "./types";

// Browser-side calls for the signed-in user's own services. The session
// cookie identifies the owner; no user id is ever sent.

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const path = (id: string) => `/api/services/${encodeURIComponent(id)}`;

export const createService = (body: ServiceCreateRequest) =>
  request<ServiceResponse>("/api/services", json("POST", body));

export const updateService = (id: string, body: ServiceUpdateRequest) =>
  request<ServiceResponse>(path(id), json("PATCH", body));

export const deleteService = (id: string) => request<null>(path(id), { method: "DELETE" });
