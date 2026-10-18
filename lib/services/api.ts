import { request } from "@/lib/auth/api";
import {
  serviceQueryParams,
  type ServiceBookingRequest,
  type ServiceBookingResponse,
  type ServiceBookingTransitionRequest,
  type ServiceCheckoutResponse,
  type ServiceDirectoryPage,
  type ServiceDirectoryQuery,
  type ServiceVerifyResponse,
} from "./marketplace";
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

// --- the Other Services marketplace -------------------------------------------------

export function searchServices(
  query: ServiceDirectoryQuery,
  cursor: string | null,
  signal?: AbortSignal,
) {
  const params = serviceQueryParams(query);
  if (cursor) params.set("cursor", cursor);
  const search = params.toString();
  return request<ServiceDirectoryPage>(
    search ? `/api/service-directory?${search}` : "/api/service-directory",
    {
      signal,
    },
  );
}

const bookingPath = (id: string) => `/api/service-bookings/${encodeURIComponent(id)}`;

export const bookService = (body: ServiceBookingRequest) =>
  request<ServiceBookingResponse>("/api/service-bookings", json("POST", body));

export const changeServiceBooking = (id: string, body: ServiceBookingTransitionRequest) =>
  request<ServiceBookingResponse>(bookingPath(id), json("PATCH", body));

/** The amount is never sent: the server charges the booking's own agreed price. */
export const checkoutServiceBooking = (id: string) =>
  request<ServiceCheckoutResponse>(`${bookingPath(id)}/checkout`, json("POST", {}));

export const verifyServicePayment = (id: string, reference: string | null) =>
  request<ServiceVerifyResponse>(
    `${bookingPath(id)}/verify-payment`,
    json("POST", reference ? { reference } : {}),
  );
