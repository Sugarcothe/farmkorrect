import { Collection, MongoServerError, type UpdateOptions } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { GET as getRoute, PATCH as replaceRoute, POST as addRoute } from "@/app/api/bank-details/route";
import { GET as banksRoute } from "@/app/api/bank-details/banks/route";
import { POST as resolveRoute } from "@/app/api/bank-details/resolve/route";
import type {
  BankAccountResponse,
  BanksResponse,
  BankVerification,
  ConfirmResponse,
  ResolveResponse,
} from "@/lib/bank-details/types";
import { collections } from "./support/db";
import { newRegistration, registerPending, registerVerified } from "./support/flows";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { paystack, TEST_PAYSTACK_KEY } from "./support/paystack";

// Paystack is faked (tests/support/paystack.ts): two registered accounts,
// "Zenith Bank" 0123456789 and "Access Bank" 1234567890.
const ZENITH = { bankCode: "057", accountNumber: "0123456789" };
const ACCESS = { bankCode: "044", accountNumber: "1234567890" };

const farmer = () => registerVerified(newRegistration());

const getAccount = (cookie?: string) => call<BankAccountResponse>(getRoute, "/api/bank-details", { cookie });
const banks = (cookie?: string) => call<BanksResponse>(banksRoute, "/api/bank-details/banks", { cookie });
const resolve = (body: unknown, cookie?: string, options: CallOptions = {}) =>
  call<ResolveResponse>(resolveRoute, "/api/bank-details/resolve", { body, cookie, ...options });
const add = (body: unknown, cookie?: string, options: CallOptions = {}) =>
  call<ConfirmResponse>(addRoute, "/api/bank-details", { body, cookie, ...options });
const replace = (body: unknown, cookie?: string, options: CallOptions = {}) =>
  call<ConfirmResponse>(replaceRoute, "/api/bank-details", { method: "PATCH", body, cookie, ...options });

function fieldErrorsOf(result: CallResult<unknown>) {
  return (result.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};
}
function errorOf(result: CallResult<unknown>) {
  return (result.json as { ok: false; error: string }).error;
}

async function verified(cookie: string, account = ZENITH): Promise<BankVerification> {
  const res = await resolve(account, cookie);
  expect(res.status).toBe(200);
  return dataOf(res).verification;
}

/** Checks and saves an account; returns the confirm body that was used. */
async function saved(cookie: string, account = ZENITH) {
  const verification = await verified(cookie, account);
  const body = { verificationId: verification.id, ...account };
  const res = await add(body, cookie);
  expect(res.status).toBe(201);
  return body;
}

const recipientRequests = () => paystack.requests.filter((r) => r.operation === "recipient");
const resolveRequests = () => paystack.requests.filter((r) => r.operation === "resolve");

async function storedAccounts() {
  return (await collections()).payoutAccounts.find().sort({ createdAt: 1 }).toArray();
}

/** Nothing sensitive in anything the app logged. */
function expectNothingSensitiveLogged() {
  const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
  for (const secret of [ZENITH.accountNumber, ACCESS.accountNumber, TEST_PAYSTACK_KEY, "ADAEZE", "RCP_"])
    expect(logged).not.toContain(secret);
}

/** Makes payout-account writes inside the save transaction fail. */
function failSaveTransaction() {
  const original = Collection.prototype.updateOne;
  return vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
    this: Collection,
    ...args: Parameters<Collection["updateOne"]>
  ) {
    const options = args[2] as UpdateOptions | undefined;
    if (this.collectionName === "payout_accounts" && options?.session)
      throw new MongoServerError({ message: "simulated outage" });
    return original.apply(this, args);
  } as never);
}

// --- bank list ---------------------------------------------------------------

describe("GET /api/bank-details/banks", () => {
  it("requires a signed-in, verified account", async () => {
    expect((await banks()).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await banks(pendingCookie)).status).toBe(403);
    expect(paystack.requests).toHaveLength(0);
  });

  it("lists transfer-capable NUBAN banks from Paystack, sorted, as code and name only", async () => {
    const { cookie } = await farmer();
    const res = await banks(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(dataOf(res).banks).toEqual([
      { code: "044", name: "Access Bank" },
      { code: "058", name: "Guaranty Trust Bank" },
      { code: "057", name: "Zenith Bank" },
    ]);
    // both pages were read, with the secret key, from the server
    expect(paystack.bankListCalls).toBe(2);
    const first = new URL(paystack.requests[0].url);
    expect(first.searchParams.get("country")).toBe("nigeria");
    expect(first.searchParams.get("currency")).toBe("NGN");
    expect(paystack.requests.every((r) => r.authorization === `Bearer ${TEST_PAYSTACK_KEY}`)).toBe(true);
  });

  it("caches the list on the server, but not failures", async () => {
    const { cookie } = await farmer();
    paystack.behaviour.banks = "server-error";
    expect((await banks(cookie)).status).toBe(502);
    paystack.behaviour.banks = "ok";
    expect((await banks(cookie)).status).toBe(200);
    const calls = paystack.bankListCalls;
    expect((await banks(cookie)).status).toBe(200);
    expect(paystack.bankListCalls).toBe(calls);
  });

  it.each([
    ["server-error", 502],
    ["malformed", 502],
    ["timeout", 502],
    ["unauthorized", 503],
  ] as const)("answers a Paystack %s with a safe %i", async (behaviour, status) => {
    const { cookie } = await farmer();
    paystack.behaviour.banks = behaviour;
    const res = await banks(cookie);
    expect(res.status).toBe(status);
    expect(errorOf(res)).not.toMatch(/sk_|invalid key|paystack\.co/i);
    expectNothingSensitiveLogged();
  });

  it("is unavailable, without calling Paystack, when no secret key is configured", async () => {
    const { cookie } = await farmer();
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    expect((await banks(cookie)).status).toBe(503);
    vi.stubEnv("PAYSTACK_SECRET_KEY", "pk_test_publickeyinstead");
    expect((await banks(cookie)).status).toBe(503);
    expect(paystack.requests).toHaveLength(0);
  });
});

// --- resolve -----------------------------------------------------------------

describe("POST /api/bank-details/resolve", () => {
  it("requires a verified session and a same-origin request", async () => {
    expect((await resolve(ZENITH)).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await resolve(ZENITH, pendingCookie)).status).toBe(403);
    const { cookie } = await farmer();
    expect((await resolve(ZENITH, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await resolve(ZENITH, cookie, { origin: null })).status).toBe(403);
    expect(resolveRequests()).toHaveLength(0);
  });

  it("returns the name Paystack has for the account and a single-use verification", async () => {
    const { cookie } = await farmer();
    const res = await resolve({ bankCode: ACCESS.bankCode, accountNumber: ACCESS.accountNumber }, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { verification } = dataOf(res);
    expect(verification).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      bankCode: "044",
      bankName: "Access Bank",
      accountName: "ADAEZE CHIOMA OKAFOR",
      accountNumberLast4: "7890",
      expiresAt: expect.any(String),
    });
    expect(new Date(verification.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(JSON.stringify(res.json)).not.toContain(ACCESS.accountNumber);

    // stored hashed and without the full number; nothing saved as the account
    const [stored] = await (await collections()).bankVerifications.find().toArray();
    expect(stored.tokenHash).not.toBe(verification.id);
    expect(JSON.stringify(stored)).not.toContain(ACCESS.accountNumber);
    expect(JSON.stringify(stored)).not.toContain(verification.id);
    expect(await storedAccounts()).toHaveLength(0);
  });

  it("asks Paystack every time (resolutions are never cached)", async () => {
    const { cookie } = await farmer();
    await verified(cookie);
    paystack.accounts.set(`${ZENITH.bankCode}:${ZENITH.accountNumber}`, "NEW NAME");
    expect((await verified(cookie)).accountName).toBe("NEW NAME");
    expect(resolveRequests()).toHaveLength(2);
  });

  it.each([
    [{ bankCode: "057", accountNumber: "" }, "accountNumber"],
    [{ bankCode: "057", accountNumber: "01234" }, "accountNumber"],
    [{ bankCode: "057", accountNumber: "01234567890" }, "accountNumber"],
    [{ bankCode: "057", accountNumber: "012345678a" }, "accountNumber"],
    [{ bankCode: "", accountNumber: "0123456789" }, "bankCode"],
    [{ bankCode: "05 7", accountNumber: "0123456789" }, "bankCode"],
    [{ bankCode: 57, accountNumber: "0123456789" }, "bankCode"],
  ])("rejects invalid input %j without calling Paystack", async (body, field) => {
    const { cookie } = await farmer();
    const res = await resolve(body, cookie);
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res)[field]).toBeTruthy();
    expect(resolveRequests()).toHaveLength(0);
  });

  it("only accepts banks from Paystack's list", async () => {
    const { cookie } = await farmer();
    for (const bankCode of ["123", "999", "MPS"]) {
      const res = await resolve({ bankCode, accountNumber: "0123456789" }, cookie);
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res).bankCode).toBe("Choose a bank from the list.");
    }
    expect(resolveRequests()).toHaveLength(0);
  });

  it("refuses an account name, verified flag or owner from the browser", async () => {
    const { cookie } = await farmer();
    const res = await resolve({ ...ZENITH, accountName: "SOMEONE ELSE", verified: true, userId: "x" }, cookie);
    expect(res.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(res)).sort()).toEqual(["accountName", "userId", "verified"]);
    expect(resolveRequests()).toHaveLength(0);
  });

  it("explains when the account can't be found", async () => {
    const { cookie } = await farmer();
    const res = await resolve({ bankCode: "058", accountNumber: "0123456789" }, cookie);
    expect(res.status).toBe(422);
    expect(fieldErrorsOf(res).accountNumber).toMatch(/couldn't find this account number at Guaranty Trust Bank/);
    expect(await (await collections()).bankVerifications.countDocuments({ active: true })).toBe(0);
  });

  it.each([
    ["server-error", 502],
    ["malformed", 502],
    ["timeout", 502],
    ["unauthorized", 503],
  ] as const)("answers a Paystack %s with a safe %i and saves nothing", async (behaviour, status) => {
    const { cookie } = await farmer();
    await banks(cookie); // cache the bank list first
    paystack.behaviour.resolve = behaviour;
    const res = await resolve(ZENITH, cookie);
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.json)).not.toMatch(/ADAEZE|sk_test|Invalid key|Could not resolve/);
    expect(await (await collections()).bankVerifications.countDocuments({ active: true })).toBe(0);
    expectNothingSensitiveLogged();
  });

  it("is rate limited per user", async () => {
    const a = await farmer();
    for (let i = 0; i < 10; i++) expect((await resolve(ZENITH, a.cookie)).status).toBe(200);
    const res = await resolve(ZENITH, a.cookie);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(resolveRequests()).toHaveLength(10);
    // other users aren't affected
    const b = await farmer();
    expect((await resolve(ZENITH, b.cookie)).status).toBe(200);
  });
});

// --- add ---------------------------------------------------------------------

describe("POST /api/bank-details", () => {
  it("requires a verified session and a same-origin request", async () => {
    const body = { verificationId: "x".repeat(43), ...ZENITH };
    expect((await add(body)).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await add(body, pendingCookie)).status).toBe(403);
    const { cookie } = await farmer();
    expect((await add(body, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect(recipientRequests()).toHaveLength(0);
  });

  it("creates a Paystack recipient with the resolved name and saves it as the current account", async () => {
    const { cookie } = await farmer();
    expect(dataOf(await getAccount(cookie)).account).toBeNull();

    const verification = await verified(cookie);
    const res = await add({ verificationId: verification.id, ...ZENITH }, cookie);
    expect(res.status).toBe(201);
    const { account } = dataOf(res);
    expect(account).toEqual({
      bankName: "Zenith Bank",
      accountName: "ADAEZE OKAFOR",
      accountNumberLast4: "6789",
      status: "recipient_created",
      readyForPayouts: true,
      verifiedAt: expect.any(String),
    });
    // neither the full number nor the recipient code is returned
    expect(JSON.stringify(res.json)).not.toContain(ZENITH.accountNumber);
    expect(JSON.stringify(res.json)).not.toContain("RCP_");

    const [request] = recipientRequests();
    const [stored] = await storedAccounts();
    expect(request.method).toBe("POST");
    expect(request.body).toEqual({
      type: "nuban",
      name: "ADAEZE OKAFOR",
      account_number: ZENITH.accountNumber,
      bank_code: "057",
      currency: "NGN",
      metadata: { farm_korret_ref: stored._id.toHexString() },
    });
    expect(stored).toMatchObject({
      bankCode: "057",
      accountNumberLast4: "6789",
      accountName: "ADAEZE OKAFOR",
      status: "recipient_created",
      recipientCode: "RCP_test1abc",
      current: true,
    });
    expect(JSON.stringify(stored)).not.toContain(ZENITH.accountNumber);
    expect(await (await collections()).bankVerifications.countDocuments({ active: true })).toBe(0);

    expect(dataOf(await getAccount(cookie)).account).toEqual(account);
  });

  it("won't reuse a verification that has already been used", async () => {
    const { cookie } = await farmer();
    const body = await saved(cookie);
    const res = await replace(body, cookie);
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res).verificationId).toBeTruthy();
    expect(recipientRequests()).toHaveLength(1);
  });

  it("won't accept an expired verification", async () => {
    const { cookie } = await farmer();
    const verification = await verified(cookie);
    await (await collections()).bankVerifications.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await add({ verificationId: verification.id, ...ZENITH }, cookie);
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res).verificationId).toMatch(/expired/);
    expect(recipientRequests()).toHaveLength(0);
    expect(await storedAccounts()).toHaveLength(0);
  });

  it("won't accept unknown or malformed verification ids", async () => {
    const { cookie } = await farmer();
    for (const verificationId of ["", "short", "A".repeat(43), "!".repeat(43)]) {
      const res = await add({ verificationId, ...ZENITH }, cookie);
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res).verificationId).toBeTruthy();
    }
    expect(recipientRequests()).toHaveLength(0);
  });

  it("is invalidated by a newer check", async () => {
    const { cookie } = await farmer();
    const first = await verified(cookie);
    const second = await verified(cookie, ACCESS);
    const res = await add({ verificationId: first.id, ...ZENITH }, cookie);
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res).verificationId).toBeTruthy();
    expect((await add({ verificationId: second.id, ...ACCESS }, cookie)).status).toBe(201);
  });

  it.each([
    ["a different account number", { accountNumber: "0123456780" }],
    ["a different bank", { bankCode: "044" }],
  ])("rejects confirming %s than was checked, and voids the check", async (_, change) => {
    const { cookie } = await farmer();
    const verification = await verified(cookie);
    const res = await add({ verificationId: verification.id, ...ZENITH, ...change }, cookie);
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res).verificationId).toMatch(/don't match/);
    // the check can't be used even with the right details now
    expect((await add({ verificationId: verification.id, ...ZENITH }, cookie)).status).toBe(400);
    expect(recipientRequests()).toHaveLength(0);
    expect(await storedAccounts()).toHaveLength(0);
  });

  it("won't let one user confirm another user's check", async () => {
    const a = await farmer();
    const b = await farmer();
    const verification = await verified(a.cookie);
    const res = await add({ verificationId: verification.id, ...ZENITH }, b.cookie);
    expect(res.status).toBe(400);
    expect(recipientRequests()).toHaveLength(0);
    expect(dataOf(await getAccount(b.cookie)).account).toBeNull();
    // still usable by its owner
    expect((await add({ verificationId: verification.id, ...ZENITH }, a.cookie)).status).toBe(201);
    expect(dataOf(await getAccount(b.cookie)).account).toBeNull();
  });

  it("refuses names, statuses, recipient codes and owners from the browser", async () => {
    const { cookie } = await farmer();
    const verification = await verified(cookie);
    const res = await add(
      {
        verificationId: verification.id,
        ...ZENITH,
        accountName: "SOMEONE ELSE",
        status: "recipient_created",
        verified: true,
        recipientCode: "RCP_mine",
        ownerUserId: "665f1c2b9d3e4a0012345678",
      },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(res)).sort()).toEqual([
      "accountName",
      "ownerUserId",
      "recipientCode",
      "status",
      "verified",
    ]);
    expect(recipientRequests()).toHaveLength(0);
    expect(await storedAccounts()).toHaveLength(0);
  });

  it("won't add a second account; that's a replacement", async () => {
    const { cookie } = await farmer();
    await saved(cookie);
    const verification = await verified(cookie, ACCESS);
    const res = await add({ verificationId: verification.id, ...ACCESS }, cookie);
    expect(res.status).toBe(409);
    expect(recipientRequests()).toHaveLength(1);
  });

  it("saves nothing when Paystack refuses the recipient, and lets the user retry", async () => {
    const { cookie } = await farmer();
    const verification = await verified(cookie);
    const body = { verificationId: verification.id, ...ZENITH };
    paystack.behaviour.recipient = "reject";
    const res = await add(body, cookie);
    expect(res.status).toBe(422);
    expect(errorOf(res)).toMatch(/couldn't set up this account/);
    expect(dataOf(await getAccount(cookie)).account).toBeNull();
    const [attempt] = await storedAccounts();
    expect(attempt).toMatchObject({ status: "failed", current: false, recipientCode: null });

    paystack.behaviour.recipient = "ok";
    expect((await add(body, cookie)).status).toBe(201);
    expect(dataOf(await getAccount(cookie)).account?.readyForPayouts).toBe(true);
  });

  it.each([
    ["server-error", 502],
    ["malformed", 502],
    ["timeout", 502],
    ["unauthorized", 503],
  ] as const)("saves nothing when recipient creation hits a %s (%i)", async (behaviour, status) => {
    const { cookie } = await farmer();
    const verification = await verified(cookie);
    paystack.behaviour.recipient = behaviour;
    const res = await add({ verificationId: verification.id, ...ZENITH }, cookie);
    expect(res.status).toBe(status);
    expect(dataOf(await getAccount(cookie)).account).toBeNull();
    expectNothingSensitiveLogged();
  });

  it("doesn't claim success when the database fails after Paystack created the recipient", async () => {
    const { cookie } = await farmer();
    const verification = await verified(cookie);
    const body = { verificationId: verification.id, ...ZENITH };
    const spy = failSaveTransaction();
    const res = await add(body, cookie);
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(errorOf(res)).toMatch(/Nothing was saved/);
    expect(JSON.stringify(res.json)).not.toMatch(/simulated|Mongo|RCP_/);
    expect(dataOf(await getAccount(cookie)).account).toBeNull();
    // kept for reconciliation, but not the user's account
    const [attempt] = await storedAccounts();
    expect(attempt).toMatchObject({ current: false, recipientCode: "RCP_test1abc" });
    expectNothingSensitiveLogged();

    // a retry succeeds and Paystack hands back the same recipient
    const retry = await add(body, cookie);
    expect(retry.status).toBe(201);
    expect(paystack.recipients.size).toBe(1);
    const current = (await storedAccounts()).filter((a) => a.current);
    expect(current).toHaveLength(1);
    expect(current[0].recipientCode).toBe("RCP_test1abc");
  });

  it("rate limits saves per user", async () => {
    const { cookie } = await farmer();
    const body = { verificationId: "x".repeat(43), ...ZENITH };
    for (let i = 0; i < 10; i++) expect((await add(body, cookie)).status).toBe(400);
    expect((await add(body, cookie)).status).toBe(429);
    expect((await replace(body, cookie)).status).toBe(429);
  });
});

// --- replace -----------------------------------------------------------------

describe("PATCH /api/bank-details", () => {
  it("replaces the current account, keeping the old one as history", async () => {
    const { cookie } = await farmer();
    await saved(cookie);
    const verification = await verified(cookie, ACCESS);
    const res = await replace({ verificationId: verification.id, ...ACCESS }, cookie);
    expect(res.status).toBe(200);
    expect(dataOf(res).account).toMatchObject({ bankName: "Access Bank", accountNumberLast4: "7890" });
    expect(dataOf(await getAccount(cookie)).account?.bankName).toBe("Access Bank");

    const [old, replacement] = await storedAccounts();
    expect(old).toMatchObject({ bankName: "Zenith Bank", current: false, replacedBy: replacement._id });
    expect(old.replacedAt).toBeInstanceOf(Date);
    expect(replacement).toMatchObject({ current: true, status: "recipient_created", recipientCode: "RCP_test2abc" });
  });

  it("needs an existing account to replace", async () => {
    const { cookie } = await farmer();
    const verification = await verified(cookie);
    const res = await replace({ verificationId: verification.id, ...ZENITH }, cookie);
    expect(res.status).toBe(404);
    expect(recipientRequests()).toHaveLength(0);
  });

  it("only touches the signed-in user's account", async () => {
    const a = await farmer();
    const b = await farmer();
    await saved(a.cookie);
    await saved(b.cookie, ACCESS);
    const verification = await verified(a.cookie, ACCESS);
    expect((await replace({ verificationId: verification.id, ...ACCESS }, a.cookie)).status).toBe(200);
    expect(dataOf(await getAccount(b.cookie)).account).toMatchObject({ bankName: "Access Bank", accountNumberLast4: "7890" });
    const current = (await storedAccounts()).filter((acc) => acc.current);
    expect(current).toHaveLength(2);
  });

  it("keeps the old account when Paystack refuses the new one", async () => {
    const { cookie } = await farmer();
    await saved(cookie);
    const before = dataOf(await getAccount(cookie)).account;
    const verification = await verified(cookie, ACCESS);
    paystack.behaviour.recipient = "reject";
    const res = await replace({ verificationId: verification.id, ...ACCESS }, cookie);
    expect(res.status).toBe(422);
    expect(dataOf(await getAccount(cookie)).account).toEqual(before);
  });

  it("keeps the old account when the database fails mid-save", async () => {
    const { cookie } = await farmer();
    await saved(cookie);
    const before = dataOf(await getAccount(cookie)).account;
    const verification = await verified(cookie, ACCESS);
    const spy = failSaveTransaction();
    const res = await replace({ verificationId: verification.id, ...ACCESS }, cookie);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(errorOf(res)).toMatch(/current bank account hasn't changed/);
    expect(dataOf(await getAccount(cookie)).account).toEqual(before);
    expect((await storedAccounts()).filter((a) => a.current)).toHaveLength(1);
  });
});

describe("GET /api/bank-details", () => {
  it("requires a verified session and is never cached", async () => {
    expect((await getAccount()).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await getAccount(pendingCookie)).status).toBe(403);
    const { cookie } = await farmer();
    const res = await getAccount(cookie);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(dataOf(res).account).toBeNull();
  });

  it("only returns the safe summary", async () => {
    const { cookie } = await farmer();
    await saved(cookie);
    const { account } = dataOf(await getAccount(cookie));
    expect(Object.keys(account!).sort()).toEqual([
      "accountName",
      "accountNumberLast4",
      "bankName",
      "readyForPayouts",
      "status",
      "verifiedAt",
    ]);
  });
});
