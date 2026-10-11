import { expect } from "vitest";
import { POST as verify } from "@/app/api/auth/otp/verify/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as saveFarm } from "@/app/api/farms/route";
import type { RegisterRequest } from "@/lib/auth/types";
import { call } from "./http";
import { lastOtp } from "./outbox";

let counter = 0;

export function newRegistration(overrides: Partial<RegisterRequest> = {}): RegisterRequest {
  counter += 1;
  const n = String(counter).padStart(4, "0");
  return {
    role: "poultry-farmer",
    fullName: "Adaeze Okafor",
    email: `farmer${n}@example.com`,
    phone: `+234803100${n}`,
    password: "GoodPassw0rd",
    ...overrides,
  };
}

export const FARM = {
  farmName: "Alao Poultry Enterprises",
  location: "Ibadan, Oyo State",
  farmType: "broiler",
  birdCount: 5000,
  yearsOfExperience: 6,
} as const;

/** Registers; returns the pending session cookie. */
export async function registerPending(input = newRegistration()) {
  const res = await call(register, "/api/auth/register", { body: input });
  expect(res.status).toBe(201);
  expect(res.sessionCookie).toBeTruthy();
  return { input, pendingCookie: res.sessionCookie! };
}

/** Registers and verifies the phone; returns the full session cookie. */
export async function registerVerified(input = newRegistration()) {
  const { pendingCookie } = await registerPending(input);
  const res = await call(verify, "/api/auth/otp/verify", {
    body: { phone: input.phone, code: lastOtp(input.phone) },
    cookie: pendingCookie,
  });
  expect(res.status).toBe(200);
  return { input, cookie: res.sessionCookie! };
}

/** A verified account that has also completed farm setup. */
export async function registerWithFarm(input = newRegistration()) {
  const account = await registerVerified(input);
  const res = await call(saveFarm, "/api/farms", { body: FARM, cookie: account.cookie });
  expect(res.status).toBe(201);
  return account;
}
