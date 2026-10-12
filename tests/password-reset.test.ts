import { describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as forgot } from "@/app/api/auth/password/forgot/route";
import { POST as reset } from "@/app/api/auth/password/reset/route";
import { GET as session } from "@/app/api/auth/session/route";
import { hashToken } from "@/lib/server/crypto";
import { collections } from "./support/db";
import { registerPending, registerVerified } from "./support/flows";
import { call } from "./support/http";
import { flushAfter, lastResetToken, outbox } from "./support/outbox";

const NEW_PASSWORD = "BrandNewPassw0rd";

async function requestReset(identifier: string) {
  const res = await call(forgot, "/api/auth/password/forgot", { body: { identifier } });
  await flushAfter();
  return res;
}

describe("POST /api/auth/password/forgot", () => {
  it("answers identically whether or not the account exists", async () => {
    const { input } = await registerVerified();
    const known = await requestReset(input.email);
    const unknown = await requestReset("nobody@example.com");
    const unknownPhone = await requestReset("+2348099999999");

    for (const res of [known, unknown, unknownPhone]) {
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, data: null });
    }
    // only the real account was sent anything
    expect(outbox.sms.filter((m) => m.text.includes("reset-password"))).toHaveLength(1);
  });

  it("texts a single-use link built from APP_URL, storing only a hash of the token", async () => {
    const { input } = await registerVerified();
    await requestReset(input.phone);

    const message = outbox.sms.at(-1)!;
    expect(message.to).toBe(input.phone.slice(1));
    expect(message.text).toContain("http://localhost:3000/auth/reset-password#token=");
    const token = lastResetToken(input.phone);

    const { resets } = await collections();
    const stored = await resets.findOne({});
    expect(stored!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("ignores the request's Host and forwarded headers when building the link", async () => {
    const { input } = await registerVerified();
    const request = new Request("https://evil.example/api/auth/password/forgot", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ identifier: input.email }),
    });
    expect((await forgot(request)).status).toBe(200);
    await flushAfter();
    expect(outbox.sms.at(-1)!.text).not.toContain("evil.example");
    expect(outbox.sms.at(-1)!.text).toContain("http://localhost:3000/");
  });

  it("sends nothing to accounts that never verified their phone", async () => {
    const { input } = await registerPending();
    const before = outbox.sms.length;
    expect((await requestReset(input.email)).status).toBe(200);
    expect(outbox.sms.length).toBe(before);
  });

  it("rate-limits requests for one account", async () => {
    const { input } = await registerVerified();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await requestReset(input.email)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("is unavailable (for everyone alike) when SMS isn't configured", async () => {
    vi.stubEnv("TERMII_API_KEY", "");
    const res = await requestReset("someone@example.com");
    expect(res.status).toBe(503);
  });
});

describe("POST /api/auth/password/reset", () => {
  it("sets the new password, revokes every session and works only once", async () => {
    const { input, cookie } = await registerVerified();
    await requestReset(input.email);
    const token = lastResetToken(input.phone);

    const res = await call(reset, "/api/auth/password/reset", { body: { token, password: NEW_PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.sessionCookie).toBe("");

    expect((await call(session, "/api/auth/session", { cookie })).status).toBe(401);
    const oldLogin = await call(login, "/api/auth/login", { body: { identifier: input.email, password: input.password } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await call(login, "/api/auth/login", { body: { identifier: input.email, password: NEW_PASSWORD } });
    expect(newLogin.status).toBe(200);

    const replay = await call(reset, "/api/auth/password/reset", { body: { token, password: "AnotherPassw0rd" } });
    expect(replay.status).toBe(400);
  });

  it("can't be used twice even concurrently", async () => {
    const { input } = await registerVerified();
    await requestReset(input.email);
    const token = lastResetToken(input.phone);
    const results = await Promise.all([
      call(reset, "/api/auth/password/reset", { body: { token, password: "FirstPassw0rd" } }),
      call(reset, "/api/auth/password/reset", { body: { token, password: "SecondPassw0rd" } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it("rejects expired tokens", async () => {
    const { input } = await registerVerified();
    await requestReset(input.email);
    const token = lastResetToken(input.phone);
    await (await collections()).resets.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await call(reset, "/api/auth/password/reset", { body: { token, password: NEW_PASSWORD } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: expect.stringMatching(/invalid or has expired/) });
  });

  it("retires older links when a new one is requested", async () => {
    const { input } = await registerVerified();
    await requestReset(input.email);
    const first = lastResetToken(input.phone);
    await requestReset(input.email);
    const second = lastResetToken(input.phone);

    expect((await call(reset, "/api/auth/password/reset", { body: { token: first, password: NEW_PASSWORD } })).status).toBe(400);
    expect((await call(reset, "/api/auth/password/reset", { body: { token: second, password: NEW_PASSWORD } })).status).toBe(200);
  });

  it("rejects made-up tokens and weak passwords", async () => {
    const forged = await call(reset, "/api/auth/password/reset", { body: { token: "x".repeat(43), password: NEW_PASSWORD } });
    expect(forged.status).toBe(400);

    const { input } = await registerVerified();
    await requestReset(input.email);
    const weak = await call(reset, "/api/auth/password/reset", {
      body: { token: lastResetToken(input.phone), password: "short" },
    });
    expect(weak.status).toBe(400);
    if (weak.json.ok) throw new Error("expected failure");
    expect(weak.json.fieldErrors?.password).toBeTruthy();
  });
});
