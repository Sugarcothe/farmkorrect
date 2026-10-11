import { describe, expect, it } from "vitest";
import { POST as resend } from "@/app/api/auth/otp/resend/route";
import { POST as verify } from "@/app/api/auth/otp/verify/route";
import { GET as session } from "@/app/api/auth/session/route";
import { POST as saveFarm } from "@/app/api/farms/route";
import { collections, userByPhone } from "./support/db";
import { FARM, registerPending } from "./support/flows";
import { call } from "./support/http";
import { lastOtp, outbox } from "./support/outbox";

function wrong(code: string) {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

async function expireCooldown(phone: string) {
  const user = await userByPhone(phone);
  await (await collections()).otp.updateMany(
    { userId: user!._id },
    { $set: { resendAvailableAt: new Date(Date.now() - 1000) } },
  );
}

describe("POST /api/auth/otp/verify", () => {
  it("activates the account and swaps the pending session for a new full one", async () => {
    const { input, pendingCookie } = await registerPending();
    const res = await call(verify, "/api/auth/otp/verify", {
      body: { phone: input.phone, code: lastOtp(input.phone) },
      cookie: pendingCookie,
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, data: { next: "farm-setup" } });
    expect(res.sessionCookie).toBeTruthy();
    expect(res.sessionCookie).not.toBe(pendingCookie);

    const user = await userByPhone(input.phone);
    expect(user!.status).toBe("active");
    expect(user!.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(user!.pendingExpiresAt).toBeUndefined();

    // the pre-verification token is dead; the new one is a full session
    expect((await call(session, "/api/auth/session", { cookie: pendingCookie })).status).toBe(401);
    expect((await call(session, "/api/auth/session", { cookie: res.sessionCookie })).status).toBe(200);
  });

  it("rejects a wrong code, counts the attempt and leaves the account unverified", async () => {
    const { input, pendingCookie } = await registerPending();
    const res = await call(verify, "/api/auth/otp/verify", {
      body: { phone: input.phone, code: wrong(lastOtp(input.phone)) },
      cookie: pendingCookie,
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ ok: false, error: expect.stringMatching(/4 attempts left/) });
    expect(res.sessionCookie).toBeUndefined();
    expect((await userByPhone(input.phone))!.status).toBe("pending_verification");
  });

  it("locks the code after five wrong attempts, even if the right code follows", async () => {
    const { input, pendingCookie } = await registerPending();
    const code = lastOtp(input.phone);
    for (let i = 0; i < 5; i++)
      await call(verify, "/api/auth/otp/verify", { body: { phone: input.phone, code: wrong(code) }, cookie: pendingCookie });

    const res = await call(verify, "/api/auth/otp/verify", { body: { phone: input.phone, code }, cookie: pendingCookie });
    expect(res.status).toBe(429);
    expect((await userByPhone(input.phone))!.status).toBe("pending_verification");
  });

  it("never lets parallel guesses exceed the attempt limit", async () => {
    const { input, pendingCookie } = await registerPending();
    const code = lastOtp(input.phone);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        call(verify, "/api/auth/otp/verify", { body: { phone: input.phone, code: wrong(code) }, cookie: pendingCookie }),
      ),
    );
    const user = await userByPhone(input.phone);
    const challenge = await (await collections()).otp.findOne({ userId: user!._id, active: true });
    expect(challenge!.attempts).toBe(5);
  });

  it("rejects an expired code", async () => {
    const { input, pendingCookie } = await registerPending();
    const user = await userByPhone(input.phone);
    await (await collections()).otp.updateOne(
      { userId: user!._id, active: true },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const res = await call(verify, "/api/auth/otp/verify", {
      body: { phone: input.phone, code: lastOtp(input.phone) },
      cookie: pendingCookie,
    });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: expect.stringMatching(/expired/) });
  });

  it("accepts a code only once, even when submitted twice at the same time", async () => {
    const { input, pendingCookie } = await registerPending();
    const body = { phone: input.phone, code: lastOtp(input.phone) };
    const results = await Promise.all([
      call(verify, "/api/auth/otp/verify", { body, cookie: pendingCookie }),
      call(verify, "/api/auth/otp/verify", { body, cookie: pendingCookie }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);

    const replay = await call(verify, "/api/auth/otp/verify", { body, cookie: pendingCookie });
    expect(replay.status).not.toBe(200);
    const { sessions } = await collections();
    expect(await sessions.countDocuments({ kind: "full" })).toBe(1);
  });

  it("requires the pending session — a phone number and code alone don't verify anything", async () => {
    const { input } = await registerPending();
    const res = await call(verify, "/api/auth/otp/verify", {
      body: { phone: input.phone, code: lastOtp(input.phone) },
    });
    expect(res.status).toBe(401);
    expect((await userByPhone(input.phone))!.status).toBe("pending_verification");
  });

  it("won't verify a different account's phone with your session", async () => {
    const a = await registerPending();
    const b = await registerPending();
    const res = await call(verify, "/api/auth/otp/verify", {
      body: { phone: b.input.phone, code: lastOtp(b.input.phone) },
      cookie: a.pendingCookie,
    });
    expect(res.status).toBe(400);
    expect((await userByPhone(b.input.phone))!.status).toBe("pending_verification");
  });

  it("a pending session can't read the session or save a farm", async () => {
    const { pendingCookie } = await registerPending();
    expect((await call(session, "/api/auth/session", { cookie: pendingCookie })).status).toBe(401);
    expect((await call(saveFarm, "/api/farms", { body: FARM, cookie: pendingCookie })).status).toBe(403);
    expect(await (await collections()).farms.countDocuments()).toBe(0);
  });
});

describe("POST /api/auth/otp/resend", () => {
  it("enforces the 45-second cooldown", async () => {
    const { input, pendingCookie } = await registerPending();
    const res = await call(resend, "/api/auth/otp/resend", { body: { phone: input.phone }, cookie: pendingCookie });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(outbox.sms).toHaveLength(1);
  });

  it("sends a new code after the cooldown and retires the old one", async () => {
    const { input, pendingCookie } = await registerPending();
    const oldCode = lastOtp(input.phone);
    await expireCooldown(input.phone);

    const res = await call(resend, "/api/auth/otp/resend", { body: { phone: input.phone }, cookie: pendingCookie });
    expect(res.status).toBe(200);
    expect(outbox.sms).toHaveLength(2);
    const newCode = lastOtp(input.phone);

    if (newCode !== oldCode) {
      const stale = await call(verify, "/api/auth/otp/verify", {
        body: { phone: input.phone, code: oldCode },
        cookie: pendingCookie,
      });
      expect(stale.status).toBe(400);
    }
    const fresh = await call(verify, "/api/auth/otp/verify", {
      body: { phone: input.phone, code: newCode },
      cookie: pendingCookie,
    });
    expect(fresh.status).toBe(200);
  });

  it("reports a failed SMS and lets the user try again straight away", async () => {
    const { input, pendingCookie } = await registerPending();
    await expireCooldown(input.phone);
    outbox.smsFailing = true;
    const failed = await call(resend, "/api/auth/otp/resend", { body: { phone: input.phone }, cookie: pendingCookie });
    expect(failed.status).toBe(502);

    outbox.smsFailing = false;
    const retry = await call(resend, "/api/auth/otp/resend", { body: { phone: input.phone }, cookie: pendingCookie });
    expect(retry.status).toBe(200);
  });

  it("requires the pending session", async () => {
    const { input } = await registerPending();
    const res = await call(resend, "/api/auth/otp/resend", { body: { phone: input.phone } });
    expect(res.status).toBe(401);
    expect(outbox.sms).toHaveLength(1);
  });
});
