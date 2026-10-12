import { describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as saveFarm } from "@/app/api/farms/route";
import { hashToken, hmac, randomOtp, randomToken } from "@/lib/server/crypto";
import { getAuthConfig } from "@/lib/server/config";
import { HttpError, MAX_JSON_BYTES, route } from "@/lib/server/http";
import { hit, peek } from "@/lib/server/rate-limit";
import { collections } from "./support/db";
import { FARM, newRegistration, registerVerified } from "./support/flows";
import { call } from "./support/http";

describe("request gate (CSRF, content type, size)", () => {
  it("rejects requests from another origin or with no Origin", async () => {
    for (const origin of ["https://evil.example", "http://localhost:3000.evil.example", null]) {
      const res = await call(register, "/api/auth/register", { body: newRegistration(), origin });
      expect(res.status).toBe(403);
    }
    expect(await (await collections()).users.countDocuments()).toBe(0);
  });

  it("rejects form posts and other non-JSON bodies", async () => {
    const res = await call(login, "/api/auth/login", {
      rawBody: "identifier=a%40b.com&password=x",
      contentType: "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(415);
  });

  it("rejects oversized bodies", async () => {
    const res = await call(login, "/api/auth/login", {
      rawBody: JSON.stringify({ identifier: "a@b.com", password: "x".repeat(MAX_JSON_BYTES) }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects malformed JSON and non-object bodies", async () => {
    for (const rawBody of ["{not json", "[1,2]", "null", '"text"']) {
      const res = await call(login, "/api/auth/login", { rawBody });
      expect(res.status).toBe(400);
    }
  });

  it("treats non-string fields as missing instead of crashing", async () => {
    const res = await call(login, "/api/auth/login", {
      body: { identifier: { $ne: null }, password: { $gt: "" } },
    });
    expect(res.status).toBe(400);
  });
});

describe("error handling", () => {
  it("never exposes internal error details", async () => {
    const handler = route("test", async () => {
      throw new Error("MongoServerError: E11000 duplicate key mongodb+srv://user:secret@cluster");
    });
    const res = await handler(new Request("http://localhost:3000/api/x"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/Mongo|E11000|secret|stack/);
    expect(JSON.parse(text)).toEqual({ ok: false, error: "Something went wrong on our side. Please try again." });
  });

  it("passes on intended messages and field errors", async () => {
    const handler = route("test", async () => {
      throw new HttpError(400, "Fix it.", { name: "Required." });
    });
    const res = await handler(new Request("http://localhost:3000/api/x"));
    expect(await res.json()).toEqual({ ok: false, error: "Fix it.", fieldErrors: { name: "Required." } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports missing configuration as unavailable without naming secrets", async () => {
    vi.stubEnv("AUTH_SECRET", "too-short");
    const res = await call(login, "/api/auth/login", { body: { identifier: "a@b.com", password: "x" } });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.json)).not.toMatch(/AUTH_SECRET|too-short/);
  });

  it("doesn't log request bodies, passwords or codes", async () => {
    const spy = vi.mocked(console.error);
    const input = newRegistration({ password: "UniqueSecretPassw0rd" });
    await call(register, "/api/auth/register", { body: input });
    await call(login, "/api/auth/login", { body: { identifier: input.email, password: "WrongPassw0rd99" } });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toMatch(/UniqueSecretPassw0rd|WrongPassw0rd99/);
    expect(logged).not.toContain(input.email);
  });
});

describe("configuration", () => {
  it("only accepts an https APP_URL outside localhost, as a bare origin", () => {
    vi.stubEnv("APP_URL", "http://farmkorret.example");
    expect(() => getAuthConfig()).toThrow();
    vi.stubEnv("APP_URL", "https://farmkorret.example/path");
    expect(() => getAuthConfig()).toThrow();
    vi.stubEnv("APP_URL", "https://farmkorret.example");
    expect(getAuthConfig()).toMatchObject({ appOrigin: "https://farmkorret.example", secureCookies: true });
  });

  it("ignores proxy IP headers unless explicitly trusted", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "false");
    // without trusted IPs, only the per-account limit applies
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await call(login, "/api/auth/login", {
        body: { identifier: "victim@example.com", password: "WrongPassw0rd" },
        ip: `203.0.113.${i}`,
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe("crypto helpers", () => {
  it("makes 6-digit codes and 256-bit tokens", () => {
    const codes = new Set(Array.from({ length: 200 }, () => randomOtp()));
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(190);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
  });

  it("keys code hashes with the server secret", () => {
    expect(hmac("secret-a", "otp", "id", "123456")).not.toBe(hmac("secret-b", "otp", "id", "123456"));
    expect(hmac("secret-a", "otp", "id", "123456")).not.toBe(hashToken("123456"));
  });
});

describe("rate limiter", () => {
  it("counts within a window and resets in the next one, shared through MongoDB", async () => {
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (let i = 0; i < 5; i++) expect((await hit("loginFailuresPerAccount", "acct", start)).limited).toBe(false);
    const sixth = await hit("loginFailuresPerAccount", "acct", start + 1000);
    expect(sixth.limited).toBe(true);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    expect((await peek("loginFailuresPerAccount", "acct", start + 16 * 60_000)).limited).toBe(false);
  });

  it("stores no raw identifiers", async () => {
    await hit("loginFailuresPerAccount", "email:someone@example.com");
    const db = (await collections()).users.db;
    const docs = await db.collection("rate_limits").find().toArray();
    expect(JSON.stringify(docs)).not.toContain("someone@example.com");
  });
});

describe("authorization of private APIs", () => {
  it("a revoked user session can't save a farm", async () => {
    const { cookie } = await registerVerified();
    await (await collections()).sessions.updateMany({}, { $set: { revokedAt: new Date() } });
    const res = await call(saveFarm, "/api/farms", { body: FARM, cookie });
    expect(res.status).toBe(401);
  });
});
