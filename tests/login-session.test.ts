import { describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as verify } from "@/app/api/auth/otp/verify/route";
import { GET as session } from "@/app/api/auth/session/route";
import { collections, userByPhone } from "./support/db";
import { newRegistration, registerPending, registerVerified, registerWithFarm } from "./support/flows";
import { call, dataOf } from "./support/http";
import { lastOtp, outbox } from "./support/outbox";

const GENERIC = "Incorrect email/phone number or password.";

describe("POST /api/auth/login", () => {
  it("logs in by email or phone and points new users at farm setup", async () => {
    const { input } = await registerVerified();

    const byEmail = await call(login, "/api/auth/login", {
      body: { identifier: input.email.toUpperCase(), password: input.password },
    });
    expect(byEmail.status).toBe(200);
    expect(byEmail.json).toEqual({ ok: true, data: { next: "farm-setup" } });
    expect(byEmail.sessionCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const byPhone = await call(login, "/api/auth/login", {
      body: { identifier: input.phone, password: input.password },
    });
    expect(byPhone.status).toBe(200);
  });

  it("sends users who finished setup to home", async () => {
    const { input } = await registerWithFarm();
    const res = await call(login, "/api/auth/login", { body: { identifier: input.email, password: input.password } });
    expect(dataOf(res)).toEqual({ next: "home" });
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    const { input } = await registerVerified();
    const wrongPassword = await call(login, "/api/auth/login", {
      body: { identifier: input.email, password: "WrongPassw0rd" },
    });
    const unknown = await call(login, "/api/auth/login", {
      body: { identifier: "nobody@example.com", password: "WrongPassw0rd" },
    });
    for (const res of [wrongPassword, unknown]) {
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ ok: false, error: GENERIC });
      expect(res.sessionCookie).toBeUndefined();
    }
  });

  it("locks an account after repeated failures, even for the right password", async () => {
    const { input } = await registerVerified();
    for (let i = 0; i < 5; i++)
      await call(login, "/api/auth/login", {
        body: { identifier: input.email, password: "WrongPassw0rd" },
        ip: `198.51.100.${i}`,
      });
    const res = await call(login, "/api/auth/login", {
      body: { identifier: input.email, password: input.password },
      ip: "198.51.100.200",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(res.sessionCookie).toBeUndefined();
  });

  it("limits failed logins from one IP across many accounts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await call(login, "/api/auth/login", {
        body: { identifier: `victim${i}@example.com`, password: "WrongPassw0rd" },
        ip: "192.0.2.50",
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("issues a fresh session on every login and revokes the one the browser had", async () => {
    const { input, cookie: before } = await registerVerified();
    const res = await call(login, "/api/auth/login", {
      body: { identifier: input.email, password: input.password },
      cookie: before,
    });
    expect(res.sessionCookie).not.toBe(before);
    expect((await call(session, "/api/auth/session", { cookie: before })).status).toBe(401);
    expect((await call(session, "/api/auth/session", { cookie: res.sessionCookie })).status).toBe(200);
  });

  it("doesn't fully sign in an unverified account; it sends a code and asks for verification", async () => {
    const input = newRegistration();
    await registerPending(input);
    await (await collections()).otp.updateMany({}, { $set: { resendAvailableAt: new Date(0) } });

    const res = await call(login, "/api/auth/login", {
      body: { identifier: input.email, password: input.password },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      data: { next: "verify", phone: input.phone, fullName: input.fullName },
    });
    expect(outbox.sms).toHaveLength(2);
    expect((await call(session, "/api/auth/session", { cookie: res.sessionCookie })).status).toBe(401);

    const verified = await call(verify, "/api/auth/otp/verify", {
      body: { phone: input.phone, code: lastOtp(input.phone) },
      cookie: res.sessionCookie,
    });
    expect(verified.status).toBe(200);
    expect((await userByPhone(input.phone))!.status).toBe("active");
  });

  it("validates input", async () => {
    const res = await call(login, "/api/auth/login", { body: { identifier: "not an id", password: "" } });
    expect(res.status).toBe(400);
    if (res.json.ok) throw new Error("expected failure");
    expect(res.json.fieldErrors).toMatchObject({ identifier: expect.any(String), password: expect.any(String) });
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax, Path=/, has a finite Max-Age and no Domain", async () => {
    const { input } = await registerVerified();
    const res = await call(login, "/api/auth/login", { body: { identifier: input.email, password: input.password } });
    const cookie = res.setCookie!;
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=2592000/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/; Secure/);
  });

  it("is Secure in production", async () => {
    const { input } = await registerVerified();
    const { vi } = await import("vitest");
    vi.stubEnv("NODE_ENV", "production");
    const res = await call(login, "/api/auth/login", { body: { identifier: input.email, password: input.password } });
    expect(res.setCookie).toMatch(/; Secure/);
  });

  it("stores only a hash of the token", async () => {
    const { cookie } = await registerVerified();
    const { sessions } = await collections();
    expect(await sessions.countDocuments({ tokenHash: cookie })).toBe(0);
    expect(JSON.stringify(await sessions.find().toArray())).not.toContain(cookie);
  });
});

describe("GET /api/auth/session", () => {
  it("returns the profile without secrets", async () => {
    const { input, cookie } = await registerWithFarm();
    const res = await call(session, "/api/auth/session", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json).toEqual({
      ok: true,
      data: {
        user: { fullName: input.fullName, role: input.role, email: input.email, phone: input.phone },
        farmSetupComplete: true,
      },
    });
    expect(JSON.stringify(res.json)).not.toMatch(/argon2|passwordHash|tokenHash|_id/);
  });

  it("rejects missing, malformed, forged and expired tokens", async () => {
    const { cookie } = await registerVerified();
    expect((await call(session, "/api/auth/session")).status).toBe(401);
    expect((await call(session, "/api/auth/session", { cookie: "garbage" })).status).toBe(401);
    expect((await call(session, "/api/auth/session", { cookie: "A".repeat(43) })).status).toBe(401);

    await (await collections()).sessions.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(session, "/api/auth/session", { cookie })).status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session server-side and clears the cookie", async () => {
    const { cookie } = await registerVerified();
    const res = await call(logout, "/api/auth/logout", { body: {}, cookie });
    expect(res.status).toBe(200);
    expect(res.sessionCookie).toBe("");
    expect(res.setCookie).toMatch(/Max-Age=0/);
    // a copy of the old cookie no longer works
    expect((await call(session, "/api/auth/session", { cookie })).status).toBe(401);
  });

  it("refuses cross-site logout requests", async () => {
    const { cookie } = await registerVerified();
    const res = await call(logout, "/api/auth/logout", { body: {}, cookie, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await call(session, "/api/auth/session", { cookie })).status).toBe(200);
  });
});
