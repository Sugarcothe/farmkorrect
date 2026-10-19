import { request } from "@/lib/auth/api";
import { queryParams } from "./query";
import type {
  AppointmentCreateRequest,
  AppointmentResponse,
  AppointmentTransitionRequest,
  AvailabilityResponse,
  AvailabilitySettings,
  DirectoryPage,
  DirectoryQuery,
  SlotsResponse,
} from "./types";
import type { ChecklistUpdateRequest, NotesUpdateRequest, VisitResponse } from "./visit";

// Browser-side calls for Find a Vet. The session cookie identifies who is
// acting; no user id, price, fee, payment or booking status is ever sent.

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** One directory page; pass the AbortSignal so a newer search can cancel this one. */
export function searchVets(query: DirectoryQuery, cursor: string | null, signal?: AbortSignal) {
  const params = queryParams(query);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return request<DirectoryPage>(search ? `/api/vets?${search}` : "/api/vets", { signal });
}

export const getSlots = (vetId: string, serviceId: string, from: string, signal?: AbortSignal) =>
  request<SlotsResponse>(
    `/api/vets/${encodeURIComponent(vetId)}/slots?${new URLSearchParams({ service: serviceId, from })}`,
    { signal },
  );

export const bookAppointment = (body: AppointmentCreateRequest) =>
  request<AppointmentResponse>("/api/appointments", json("POST", body));

export const changeAppointment = (id: string, body: AppointmentTransitionRequest) =>
  request<AppointmentResponse>(`/api/appointments/${encodeURIComponent(id)}`, json("PATCH", body));

/** Ticks or clears one checklist item on the vet's visit record. */
export const updateChecklist = (id: string, body: ChecklistUpdateRequest) =>
  request<VisitResponse>(`/api/appointments/${encodeURIComponent(id)}/visit/checklist`, json("POST", body));

/** Saves the vet's private notes; fails with a conflict if they changed since `expectedVersion`. */
export const saveVisitNotes = (id: string, body: NotesUpdateRequest) =>
  request<VisitResponse>(`/api/appointments/${encodeURIComponent(id)}/visit/notes`, json("PUT", body));

export const saveAvailability = (body: AvailabilitySettings) =>
  request<AvailabilityResponse>("/api/availability", json("PUT", body));
