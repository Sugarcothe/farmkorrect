import { describe, expect, it, vi } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { collections, userByPhone } from "./support/db";
import { newRegistration, registerPending, registerVerified } from "./support/flows";
import { call } from "./support/http";
import { lastOtp, outbox } from "./support/outbox";

describe("POST /api/auth/register", () => {
  it("creates an unverified account, texts a code and sets a pending session cookie", async () => {
    const input = newRegistration({ email: "  Ada@Example.COM ", phone: "0803 555 0101" });
    const res = await call(register, "/api/auth/register", { body: input });

    expect(res.status).toBe(201);
    expect(res.json).toEqual({ ok: true, data: { phone: "+2348035550101" } });

    const user = await userByPhone("+2348035550101");
    expect(user).toMatchObject({
      emailNormalized: "ada@example.com",
      status: "pending_verification",
      phoneVerifiedAt: null,
      role: "poultry-farmer",
    });
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user!.passwordHash).not.toContain(input.password);

    expect(outbox.sms).toHaveLength(1);
    expect(outbox.sms[0].to).toBe("2348035550101");
    const code = lastOtp("+2348035550101");

    // the code is never returned, and only an HMAC of it is stored
    expect(JSON.stringify(res.json)).not.toContain(code);
    const { otp, sessions } = await collections();
    const challenge = await otp.findOne({ userId: user!._id });
    expect(challenge!.codeHash).not.toContain(code);
    expect(challenge!.codeHash).toMatch(/^[0-9a-f]{64}$/);

    const session = await sessions.findOne({ userId: user!._id });
    expect(session!.kind).toBe("pending");
    expect(session!.tokenHash).not.toBe(res.sessionCookie);
  });

  it("returns field errors for invalid input and creates nothing", async () => {
    const res = await call(register, "/api/auth/register", {
      body: { role: "admin", fullName: "", email: "nope", phone: "12345", password: "short" },
    });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    if (res.json.ok) return;
    expect(Object.keys(res.json.fieldErrors ?? {}).sort()).toEqual(
      ["email", "fullName", "password", "phone", "role"].sort(),
    );
    expect(await (await collections()).users.countDocuments()).toBe(0);
    expect(outbox.sms).toHaveLength(0);
  });

  it("rejects an email that belongs to a verified account without touching that account", async () => {
    const { input } = await registerVerified();
    const before = await userByPhone(input.phone);

    const res = await call(register, "/api/auth/register", {
      body: newRegistration({ email: input.email.toUpperCase() }),
    });
    expect(res.status).toBe(409);
    if (res.json.ok) throw new Error("expected failure");
    expect(res.json.fieldErrors?.email).toMatch(/already exists/);

    expect(await userByPhone(input.phone)).toEqual(before);
  });

  it("rejects a phone number that belongs to a verified account", async () => {
    const { input } = await registerVerified();
    const res = await call(register, "/api/auth/register", {
      body: newRegistration({ phone: input.phone }),
    });
    expect(res.status).toBe(409);
    if (res.json.ok) throw new Error("expected failure");
    expect(res.json.fieldErrors?.phone).toMatch(/already exists/);
    expect((await userByPhone(input.phone))!.status).toBe("active");
  });

  it("lets an abandoned, unverified sign-up be started again", async () => {
    const first = newRegistration();
    const { pendingCookie } = await registerPending(first);

    const again = { ...first, fullName: "Adaeze N. Okafor" };
    const res = await call(register, "/api/auth/register", { body: again });
    expect(res.status).toBe(201);

    const { users, sessions } = await collections();
    expect(await users.countDocuments({ phoneNormalized: first.phone })).toBe(1);
    expect((await userByPhone(first.phone))!.fullName).toBe("Adaeze N. Okafor");
    // the abandoned attempt's session no longer works
    const oldHashes = await sessions.countDocuments({ revokedAt: null });
    expect(oldHashes).toBe(1);
    expect(res.sessionCookie).not.toBe(pendingCookie);
  });

  it("does not keep an account when the SMS can't be sent, so the user can retry", async () => {
    outbox.smsFailing = true;
    const input = newRegistration();
    const res = await call(register, "/api/auth/register", { body: input });
    expect(res.status).toBe(502);
    expect(res.sessionCookie).toBeUndefined();
    expect(await userByPhone(input.phone)).toBeNull();

    outbox.smsFailing = false;
    const retry = await call(register, "/api/auth/register", { body: input });
    expect(retry.status).toBe(201);
  });

  it("refuses sign-up when SMS isn't configured, before creating anything", async () => {
    vi.stubEnv("TERMII_API_KEY", "");
    const input = newRegistration();
    const res = await call(register, "/api/auth/register", { body: input });
    expect(res.status).toBe(503);
    expect(await userByPhone(input.phone)).toBeNull();
    expect(outbox.sms).toHaveLength(0);
  });

  it("allows only one account when the same details are submitted concurrently", async () => {
    const input = newRegistration();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call(register, "/api/auth/register", { body: input })),
    );
    expect(results.some((r) => r.status === 201)).toBe(true);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await (await collections()).users.countDocuments({ phoneNormalized: input.phone })).toBe(1);
  });

  it("rate-limits repeated sign-ups for one phone number", async () => {
    const input = newRegistration();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await call(register, "/api/auth/register", { body: input })).status);
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
