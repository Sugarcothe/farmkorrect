import { randomUUID } from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { GET as auditRoute } from "@/app/api/admin/audit/route";
import { GET as analyticsRoute } from "@/app/api/admin/analytics/route";
import { GET as caseRoute, POST as changeCaseRoute } from "@/app/api/admin/cases/[reference]/route";
import { GET as casesRoute, POST as createCaseRoute } from "@/app/api/admin/cases/route";
import { GET as credentialsRoute } from "@/app/api/admin/credentials/route";
import { GET as exceptionsRoute } from "@/app/api/admin/exceptions/route";
import { GET as summaryRoute } from "@/app/api/admin/summary/route";
import { POST as teamLookupRoute } from "@/app/api/admin/team/lookup/route";
import { GET as memberRoute, POST as changeRoleRoute } from "@/app/api/admin/team/[userId]/route";
import { GET as teamRoute, POST as grantRoute } from "@/app/api/admin/team/route";
import { GET as trainingRoute } from "@/app/api/admin/training/courses/route";
import { GET as accountRoute } from "@/app/api/admin/users/[id]/route";
import { POST as statusRoute } from "@/app/api/admin/users/[id]/status/route";
import { POST as lookupRoute } from "@/app/api/admin/users/lookup/route";
import { GET as suspendedRoute } from "@/app/api/admin/users/route";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as profileRoute } from "@/app/api/profile/route";
import type {
  AccountDetail,
  AccountLookupResponse,
  AccountPage,
  TeamLookupResponse,
  TeamMemberDetail,
  TeamOverview,
} from "@/lib/admin/accounts";
import type { CaseListResponse, CaseResponse } from "@/lib/admin/cases";
import type { AdminRole } from "@/lib/admin/permissions";
import type { AdminSummary, ExceptionPage } from "@/lib/admin/types";
import { getDb } from "@/lib/server/db";
import { COLLECTIONS, type AdminCaseDoc, type AdminMembershipDoc, type PayoutDoc } from "@/lib/server/models";
import { collections } from "./support/db";
import { newRegistration, registerVerified } from "./support/flows";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { flushAfter } from "./support/outbox";

// Admin Operations V2 (docs/admin-operations-v2.md): roles granted on top of
// the ADMIN_USER_IDS root list, account suspension, the case centre and the
// read-only booking and finance exceptions. Everything is checked through
// the real route handlers; nothing calls a live provider, and no test
// expects (or allows) money to move.

const REASON = "Agreed in the weekly operations review.";

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

function callWith<T, P>(handler: Handler<P>, path: string, params: P, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve(params) }), path, options);
}

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

type Account = { cookie: string; userId: ObjectId; phone: string; email: string; password: string };

async function person(): Promise<Account> {
  const { input, cookie } = await registerVerified(newRegistration({ role: "veterinarian" }));
  const user = await (await collections()).users.findOne({ phoneNormalized: input.phone });
  return { cookie, userId: user!._id, phone: input.phone, email: input.email, password: input.password };
}

const hex = (a: Account) => a.userId.toHexString();

/** Makes these accounts the root admins (and only these). */
const roots = (...accounts: Account[]) => vi.stubEnv("ADMIN_USER_IDS", accounts.map(hex).join(","));

async function rootAdmin() {
  const account = await person();
  roots(account);
  return account;
}

async function grant(by: Account, to: Account, role: AdminRole) {
  return call<TeamMemberDetail>(grantRoute, "/api/admin/team", {
    cookie: by.cookie,
    body: { userId: hex(to), role, reason: REASON },
  });
}

/** A new account holding `role`, granted by `by` through the team API. */
async function staff(by: Account, role: AdminRole) {
  const account = await person();
  expect((await grant(by, account, role)).status).toBe(200);
  return account;
}

const membershipOf = async (a: Account) =>
  (await getDb())
    .collection<AdminMembershipDoc>(COLLECTIONS.adminMemberships)
    .findOne({ userId: a.userId, status: "active" });

const auditActions = async () =>
  (await (await collections()).adminAudit.find({}).sort({ at: 1, _id: 1 }).toArray()).map((e) => e.action);

const changeRole = (by: Account, target: Account, body: Record<string, unknown>) =>
  callWith<TeamMemberDetail, { userId: string }>(
    changeRoleRoute,
    `/api/admin/team/${hex(target)}`,
    { userId: hex(target) },
    {
      cookie: by.cookie,
      body: { reason: REASON, ...body },
    },
  );

const setStatus = (by: Account, target: Account, body: Record<string, unknown>) =>
  callWith<AccountDetail, { id: string }>(
    statusRoute,
    `/api/admin/users/${hex(target)}/status`,
    { id: hex(target) },
    {
      cookie: by.cookie,
      body: { reason: REASON, confirmed: true, ...body },
    },
  );

const lookup = (by: Account, q: string, extra: Record<string, unknown> = {}) =>
  call<AccountLookupResponse>(lookupRoute, "/api/admin/users/lookup", { cookie: by.cookie, body: { q, ...extra } });

// --- flagged records ---------------------------------------------------------------------

const code8 = () => randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

async function flaggedPayout(issue: string | null = "Paystack reported success after the payout had failed.") {
  const now = new Date();
  const payout = {
    _id: new ObjectId(),
    userId: new ObjectId(),
    walletAccountId: new ObjectId(),
    amountKobo: 12_000_00,
    currency: "NGN",
    status: "failed",
    payoutAccountId: new ObjectId(),
    recipientCode: "RCP_supersecretrecipient",
    bankName: "Zenith Bank",
    accountNumberLast4: "6789",
    reference: `fkp_${new ObjectId().toHexString()}`,
    transferCode: "TRF_secrettransfer",
    providerStatus: "reversed-raw-provider-status",
    failureReason: "provider_reversed",
    issue,
    transferInitiatedAt: now,
    lastCheckedAt: now,
    requestedAt: now,
    processingAt: now,
    paidAt: null,
    failedAt: now,
    history: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as PayoutDoc;
  await (await collections()).payouts.insertOne(payout);
  return payout;
}

async function flaggedBooking() {
  const now = new Date();
  const booking = {
    _id: new ObjectId(),
    reference: `FK-SVC-${code8()}`,
    customerUserId: new ObjectId(),
    providerUserId: new ObjectId(),
    serviceId: new ObjectId(),
    location: { address: "14 Secret Close, Ibadan", state: "Oyo", directions: "Blue gate" },
    notes: "Private customer note",
    status: "cancelled",
    amountKobo: 30_000_00,
    paymentStatus: "refund_failed",
    paidKobo: 30_000_00,
    paymentReference: "fks_private_payment_reference",
    paidAt: now,
    refundedKobo: 0,
    openKey: null,
    idempotencyKey: randomUUID(),
    reviewIssue: "refund fkr_1 failed: the provider declined it",
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  await db.collection(COLLECTIONS.serviceBookings).insertOne(booking);
  await db.collection(COLLECTIONS.serviceRefunds).insertOne({
    _id: new ObjectId(),
    bookingId: booking._id,
    status: "failed",
    amountKobo: 30_000_00,
    createdAt: now,
  });
  return booking;
}

const createCase = (by: Account, body: Record<string, unknown>) =>
  call<CaseResponse>(createCaseRoute, "/api/admin/cases", { cookie: by.cookie, body });

const getCase = (by: Account, reference: string) =>
  callWith<CaseResponse, { reference: string }>(
    caseRoute,
    `/api/admin/cases/${reference}`,
    { reference },
    { cookie: by.cookie },
  );

const changeCase = (by: Account, reference: string, body: Record<string, unknown>) =>
  callWith<CaseResponse, { reference: string }>(
    changeCaseRoute,
    `/api/admin/cases/${reference}`,
    { reference },
    {
      cookie: by.cookie,
      body,
    },
  );

/** Everything that holds or records money, as stored. */
async function moneySnapshot() {
  const c = await collections();
  const db = await getDb();
  const all = (col: Collection) => col.find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify({
    orders: await all(c.orders as unknown as Collection),
    payments: await all(c.orderPayments as unknown as Collection),
    refunds: await all(c.refunds as unknown as Collection),
    payouts: await all(c.payouts as unknown as Collection),
    ledger: await all(c.ledger as unknown as Collection),
    wallets: await all(c.wallets as unknown as Collection),
    bookings: await all(db.collection(COLLECTIONS.serviceBookings)),
    serviceRefunds: await all(db.collection(COLLECTIONS.serviceRefunds)),
  });
}

// --- roles and capabilities ------------------------------------------------------------------

describe("admin roles and capabilities", () => {
  it("gives each role only its own capabilities: 403 for other admin areas, 404 for non-admins", async () => {
    const root = await rootAdmin();
    const support = await staff(root, "support_agent");
    const content = await staff(root, "content_manager");
    const nobody = await person();

    const get = (handler: (r: Request) => Promise<Response>, path: string, who: Account) =>
      call(handler, path, { cookie: who.cookie }).then((r) => r.status);

    // the Support Agent's areas
    expect(await get(suspendedRoute, "/api/admin/users", support)).toBe(200);
    expect(await get(casesRoute, "/api/admin/cases", support)).toBe(200);
    expect(await get(exceptionsRoute, "/api/admin/exceptions?kind=deliveries", support)).toBe(200);
    // and nothing else
    expect(await get(exceptionsRoute, "/api/admin/exceptions?kind=payouts", support)).toBe(403);
    expect(await get(exceptionsRoute, "/api/admin/exceptions?kind=bookings", support)).toBe(403);
    expect(await get(teamRoute, "/api/admin/team", support)).toBe(403);
    expect(await get(credentialsRoute, "/api/admin/credentials", support)).toBe(403);
    expect(await get(auditRoute, "/api/admin/audit", support)).toBe(403);
    expect(await get(analyticsRoute, "/api/admin/analytics", support)).toBe(403);
    expect(await get(trainingRoute, "/api/admin/training/courses", support)).toBe(403);
    expect((await setStatus(support, nobody, { action: "suspend", expectedVersion: 0 })).status).toBe(403);

    // the Content Manager has training only
    expect(await get(trainingRoute, "/api/admin/training/courses", content)).toBe(200);
    expect(await get(suspendedRoute, "/api/admin/users", content)).toBe(403);
    expect(await get(casesRoute, "/api/admin/cases", content)).toBe(403);

    // non-admins don't learn that any of it exists
    for (const [handler, path] of [
      [suspendedRoute, "/api/admin/users"],
      [teamRoute, "/api/admin/team"],
      [casesRoute, "/api/admin/cases"],
    ] as const)
      expect(await get(handler, path, nobody)).toBe(404);

    // the dashboard only carries the counts a role covers
    const summary = dataOf(await call<AdminSummary>(summaryRoute, "/api/admin/summary", { cookie: support.cookie }));
    expect(summary).toMatchObject({ failedDeliveries: 0, openIssues: 0, openCases: 0, suspendedAccounts: 0 });
    for (const key of ["flaggedPayouts", "flaggedOrders", "flaggedBookings", "pendingCredentials", "recentActions"])
      expect(summary).not.toHaveProperty(key);
    expect(dataOf(await call<AdminSummary>(summaryRoute, "/api/admin/summary", { cookie: content.cookie }))).toEqual(
      {},
    );
  });

  it("ignores roles, flags and memberships that didn't come from a Super Admin", async () => {
    const root = await rootAdmin();
    const nobody = await person();

    // claims in the request mean nothing
    expect(
      (await call(suspendedRoute, "/api/admin/users?role=super_admin&admin=1", { cookie: nobody.cookie })).status,
    ).toBe(404);
    expect(
      (
        await call(teamLookupRoute, "/api/admin/team/lookup", {
          cookie: nobody.cookie,
          body: { q: hex(root), isAdmin: true, role: "super_admin" },
        })
      ).status,
    ).toBe(404);
    expect((await call(suspendedRoute, "/api/admin/users", { cookie: "forged-session-token" })).status).toBe(401);

    // a membership with a role that doesn't exist is no role at all (fail closed)
    const memberships = (await getDb()).collection(COLLECTIONS.adminMemberships);
    const now = new Date();
    await memberships.insertOne({
      _id: new ObjectId(),
      userId: nobody.userId,
      role: "owner",
      status: "active",
      grantedBy: root.userId,
      grantedAt: now,
      updatedBy: root.userId,
      updatedAt: now,
      revokedBy: null,
      revokedAt: null,
      version: 1,
    });
    expect((await call(suspendedRoute, "/api/admin/users", { cookie: nobody.cookie })).status).toBe(404);
    expect((await call(summaryRoute, "/api/admin/summary", { cookie: nobody.cookie })).status).toBe(404);
  });

  it("fails closed for everyone, granted roles included, when the root list is empty or malformed", async () => {
    const root = await rootAdmin();
    const support = await staff(root, "support_agent");
    expect((await call(suspendedRoute, "/api/admin/users", { cookie: support.cookie })).status).toBe(200);

    for (const value of ["", `${hex(root)},not-an-id`, `${hex(root)},`]) {
      vi.stubEnv("ADMIN_USER_IDS", value);
      expect((await call(suspendedRoute, "/api/admin/users", { cookie: support.cookie })).status).toBe(404);
      expect((await call(teamRoute, "/api/admin/team", { cookie: root.cookie })).status).toBe(404);
    }
  });

  it("ends a revoked role on the very next request, and audits every change against its version", async () => {
    const root = await rootAdmin();
    const support = await staff(root, "support_agent");
    expect((await call(suspendedRoute, "/api/admin/users", { cookie: support.cookie })).status).toBe(200);

    const detail = dataOf(
      await callWith<TeamMemberDetail, { userId: string }>(
        memberRoute,
        `/api/admin/team/${hex(support)}`,
        { userId: hex(support) },
        {
          cookie: root.cookie,
        },
      ),
    );
    expect(detail.member).toMatchObject({ role: "support_agent", root: false, version: 1 });

    // change it, then try again from the stale page
    const changed = await changeRole(root, support, { action: "change", role: "finance_ops", expectedVersion: 1 });
    expect(dataOf(changed).member).toMatchObject({ role: "finance_ops", version: 2 });
    const stale = await changeRole(root, support, { action: "revoke", expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatch(/changed since you loaded it/);
    // the change took effect: finance can't look up accounts any more
    expect((await call(suspendedRoute, "/api/admin/users", { cookie: support.cookie })).status).toBe(403);

    expect((await changeRole(root, support, { action: "revoke", expectedVersion: 2 })).status).toBe(200);
    expect((await call(casesRoute, "/api/admin/cases", { cookie: support.cookie })).status).toBe(404);
    expect(await membershipOf(support)).toBeNull();

    const team = dataOf(await call<TeamOverview>(teamRoute, "/api/admin/team", { cookie: root.cookie }));
    expect(team.members.map((m) => m.userId)).toEqual([hex(root)]);
    expect(team.members[0]).toMatchObject({ role: "super_admin", root: true });
    expect(team.revoked).toEqual([expect.objectContaining({ userId: hex(support), role: "finance_ops" })]);
    expect(await auditActions()).toEqual(["membership.grant", "membership.change", "membership.revoke"]);
  });

  it("keeps Super Admin root-only, protects root and self, and grants only to active verified accounts", async () => {
    const root = await rootAdmin();
    const superAdmin = await staff(root, "super_admin");
    const other = await person();

    // a granted Super Admin manages the team but can't create or touch Super Admins
    const promote = await grant(superAdmin, other, "super_admin");
    expect(promote.status).toBe(403);
    expect((await grant(superAdmin, other, "trust_safety")).status).toBe(200);
    expect(
      (await changeRole(superAdmin, other, { action: "change", role: "super_admin", expectedVersion: 1 })).status,
    ).toBe(403);
    expect((await changeRole(superAdmin, root, { action: "revoke", expectedVersion: 1 })).status).toBe(403);
    expect((await changeRole(superAdmin, superAdmin, { action: "revoke", expectedVersion: 1 })).status).toBe(403);

    // granting to root, oneself or an account that already has a role is refused
    expect((await grant(superAdmin, root, "support_agent")).status).toBe(409);
    expect((await grant(superAdmin, superAdmin, "support_agent")).status).toBe(409);
    expect((await grant(superAdmin, other, "support_agent")).status).toBe(409);

    // the lookup says why before anyone tries, with masked details only
    const found = dataOf(
      await call<TeamLookupResponse>(teamLookupRoute, "/api/admin/team/lookup", {
        cookie: superAdmin.cookie,
        body: { q: root.phone },
      }),
    );
    expect(found.candidate?.blocked).toMatch(/root admin/);
    expect(JSON.stringify(found)).not.toContain(root.phone);
    expect(JSON.stringify(found)).not.toContain(root.email);

    // only active, phone-verified accounts
    const suspended = await person();
    await (await collections()).users.updateOne({ _id: suspended.userId }, { $set: { status: "suspended" } });
    expect((await grant(root, suspended, "support_agent")).status).toBe(409);

    // unknown fields and roles are rejected
    const forged = await call(grantRoute, "/api/admin/team", {
      cookie: root.cookie,
      body: { userId: hex(suspended), role: "owner", reason: REASON, capabilities: ["admin.team.manage"] },
    });
    expect(forged.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(forged))).toEqual(expect.arrayContaining(["role"]));
  });
});

// --- accounts ---------------------------------------------------------------------------

describe("account lookup and suspension", () => {
  it("finds one account by an exact id, phone or email, and shows only masked details", async () => {
    const root = await rootAdmin();
    const support = await staff(root, "support_agent");
    const target = await person();

    for (const q of [hex(target), target.phone, target.email.toUpperCase()]) {
      const res = await lookup(support, q);
      const account = dataOf(res).account;
      expect(account).toMatchObject({ id: hex(target), status: "active", phoneVerified: true });
      expect(account!.phoneMasked).toMatch(/\*+/);
      const text = JSON.stringify(res.json);
      expect(text).not.toContain(target.phone);
      expect(text).not.toContain(target.email);
      expect(text).not.toMatch(/passwordHash|\$2[aby]\$/);
    }
    // nothing matches a partial value; partial or empty searches are rejected, not widened
    expect(dataOf(await lookup(support, "nobody@example.com")).account).toBeNull();
    expect((await lookup(support, "0803")).status).toBe(400);
    expect((await lookup(support, "")).status).toBe(400);
    expect((await lookup(support, target.phone, { role: "super_admin" })).status).toBe(400);

    const detail = dataOf(
      await callWith<AccountDetail, { id: string }>(
        accountRoute,
        `/api/admin/users/${hex(target)}`,
        { id: hex(target) },
        {
          cookie: support.cookie,
        },
      ),
    );
    expect(detail).toMatchObject({ statusVersion: 0, admin: null, suspension: null, history: [] });
  });

  it("suspends in one step: sessions revoked, sign-in refused, admin role ended, owner told without the reason", async () => {
    const root = await rootAdmin();
    const target = await staff(root, "support_agent");
    const reason = "Repeated chargeback abuse confirmed by finance.";

    // a reason, an explicit confirmation and the version the admin saw are all required
    expect(
      (await setStatus(root, target, { action: "suspend", reason, confirmed: false, expectedVersion: 0 })).status,
    ).toBe(400);
    expect((await setStatus(root, target, { action: "suspend", reason: "", expectedVersion: 0 })).status).toBe(400);
    expect((await setStatus(root, target, { action: "suspend", reason, expectedVersion: 3 })).status).toBe(409);

    const res = await setStatus(root, target, { action: "suspend", reason, expectedVersion: 0 });
    expect(dataOf(res)).toMatchObject({ status: "suspended", statusVersion: 1, admin: null });
    await flushAfter();

    // signed out everywhere, and can't sign back in
    expect((await call(profileRoute, "/api/profile", { cookie: target.cookie })).status).toBe(401);
    const again = await call(login, "/api/auth/login", {
      body: { identifier: target.phone, password: target.password },
    });
    expect(again.status).toBe(403);
    expect(errorOf(again)).toMatch(/suspended/);
    expect(again.sessionCookie ?? "").toBe("");
    const { sessions, notifications } = await collections();
    expect(await sessions.countDocuments({ userId: target.userId, revokedAt: null })).toBe(0);

    // the admin role went with it, in the same transaction, and both are audited
    expect(await membershipOf(target)).toBeNull();
    expect(await auditActions()).toEqual(["membership.grant", "user.suspend", "membership.revoke"]);

    // the owner hears about it, but never the internal reason
    const notices = await notifications.find({ recipientUserId: target.userId, type: "account_suspended" }).toArray();
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain(reason);

    // the same change twice is refused, not repeated
    expect((await setStatus(root, target, { action: "suspend", expectedVersion: 1 })).status).toBe(409);

    // reactivating lets them sign in again but gives nothing back
    const back = await setStatus(root, target, { action: "reactivate", expectedVersion: 1 });
    expect(dataOf(back)).toMatchObject({ status: "active", statusVersion: 2, admin: null });
    const signedIn = await call(login, "/api/auth/login", {
      body: { identifier: target.phone, password: target.password },
    });
    expect(signedIn.status).toBe(200);
    expect((await call(suspendedRoute, "/api/admin/users", { cookie: signedIn.sessionCookie })).status).toBe(404);
    expect(await membershipOf(target)).toBeNull();
    expect(await sessions.countDocuments({ userId: target.userId, revokedAt: { $ne: null } })).toBeGreaterThan(0);
  });

  it("never suspends oneself or a root admin, and only root suspends a Super Admin", async () => {
    const root = await rootAdmin();
    const superAdmin = await staff(root, "super_admin");
    const otherSuper = await staff(root, "super_admin");

    expect((await setStatus(root, root, { action: "suspend", expectedVersion: 0 })).status).toBe(403);
    expect((await setStatus(superAdmin, root, { action: "suspend", expectedVersion: 0 })).status).toBe(403);
    expect((await setStatus(superAdmin, superAdmin, { action: "suspend", expectedVersion: 0 })).status).toBe(403);
    expect((await setStatus(superAdmin, otherSuper, { action: "suspend", expectedVersion: 0 })).status).toBe(403);
    expect((await setStatus(root, otherSuper, { action: "suspend", expectedVersion: 0 })).status).toBe(200);

    const page = dataOf(await call<AccountPage>(suspendedRoute, "/api/admin/users", { cookie: superAdmin.cookie }));
    expect(page.accounts.map((a) => a.id)).toEqual([hex(otherSuper)]);
    // nothing was written for the refused attempts
    expect((await auditActions()).filter((a) => a.startsWith("user."))).toEqual(["user.suspend"]);
  });
});

// --- cases ----------------------------------------------------------------------------------

describe("case centre", () => {
  it("opens a case only for a flagged record, at most one open per record, without changing the record", async () => {
    const root = await rootAdmin();
    const finance = await staff(root, "finance_ops");
    const payout = await flaggedPayout();
    const quiet = await flaggedPayout(null);
    await (await collections()).payouts.updateOne({ _id: quiet._id }, { $set: { status: "paid" } });
    const before = await moneySnapshot();

    const created = await createCase(finance, { type: "payout", sourceId: payout.reference });
    const detail = dataOf(created).case;
    expect(detail).toMatchObject({
      type: "payout",
      sourceId: payout.reference,
      status: "open",
      priority: "high",
      version: 1,
    });
    expect(detail.reference).toMatch(/^FKC-[A-Z0-9]{8}$/);
    const text = JSON.stringify(created.json);
    for (const secret of ["RCP_supersecretrecipient", "TRF_secrettransfer", "reversed-raw-provider-status"])
      expect(text).not.toContain(secret);

    // a second one (even at the same moment) names the open case instead
    const twice = await createCase(finance, { type: "payout", sourceId: payout.reference });
    expect(twice.status).toBe(409);
    expect(fieldErrorsOf(twice).reference).toBe(detail.reference);

    // nothing to investigate, or nothing there
    expect((await createCase(finance, { type: "payout", sourceId: quiet.reference })).status).toBe(409);
    expect(
      (await createCase(finance, { type: "payout", sourceId: `fkp_${new ObjectId().toHexString()}` })).status,
    ).toBe(404);
    expect((await createCase(finance, { type: "payout", sourceId: payout.reference, status: "resolved" })).status).toBe(
      400,
    );

    // the exceptions list links to it, and the record itself is untouched
    const exceptions = dataOf(
      await call<ExceptionPage>(exceptionsRoute, "/api/admin/exceptions?kind=payouts", { cookie: finance.cookie }),
    );
    expect(exceptions.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: payout.reference,
          openCase: { reference: detail.reference, status: "open" },
        }),
      ]),
    );
    expect(await moneySnapshot()).toBe(before);
    expect(await auditActions()).toEqual(["membership.grant", "case.create"]);
  });

  it("lets only one of two simultaneous creates through", async () => {
    const root = await rootAdmin();
    const payout = await flaggedPayout();
    const results = await Promise.all([
      createCase(root, { type: "payout", sourceId: payout.reference }),
      createCase(root, { type: "payout", sourceId: payout.reference }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await (await getDb()).collection<AdminCaseDoc>(COLLECTIONS.adminCases).countDocuments({ open: true })).toBe(
      1,
    );
  });

  it("applies each change only against the current version, and audits it with the change", async () => {
    const root = await rootAdmin();
    const finance = await staff(root, "finance_ops");
    const colleague = await staff(root, "finance_ops");
    const payout = await flaggedPayout();
    const reference = dataOf(await createCase(root, { type: "payout", sourceId: payout.reference })).case.reference;
    const note = "Called the bank: the reversal is still pending on their side.";

    // anyone with the case type can add a note; it bumps the version
    const noted = dataOf(await changeCase(colleague, reference, { action: "note", note, expectedVersion: 1 }));
    expect(noted.case).toMatchObject({ version: 2, notes: [expect.objectContaining({ body: note })] });

    // a change from a stale page is refused and nothing is written
    const stale = await changeCase(finance, reference, { action: "priority", priority: "urgent", expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(dataOf(await getCase(finance, reference)).case).toMatchObject({ priority: "high", version: 2 });

    // a manager takes the unassigned case; then a colleague can note it but not work it
    const taken = dataOf(
      await changeCase(finance, reference, { action: "assign", assigneeId: hex(finance), expectedVersion: 2 }),
    );
    expect(taken.case.assignee?.id).toBe(hex(finance));
    expect(
      (await changeCase(colleague, reference, { action: "status", status: "in_progress", expectedVersion: 3 })).status,
    ).toBe(403);
    expect(
      (await changeCase(colleague, reference, { action: "assign", assigneeId: hex(colleague), expectedVersion: 3 }))
        .status,
    ).toBe(403);
    expect(dataOf(await getCase(colleague, reference)).permissions).toEqual({ work: false, note: true, assign: false });

    // resolving needs a code and a note; then only reopening is possible
    expect(
      (await changeCase(finance, reference, { action: "resolve", code: "paid_out", note: "Done.", expectedVersion: 3 }))
        .status,
    ).toBe(400);
    const resolved = dataOf(
      await changeCase(finance, reference, {
        action: "resolve",
        code: "escalated_finance",
        note: "Handed to the finance lead to decide on the reversal.",
        expectedVersion: 3,
      }),
    );
    expect(resolved.case).toMatchObject({
      status: "resolved",
      version: 4,
      resolution: expect.objectContaining({ code: "escalated_finance" }),
    });
    expect((await changeCase(finance, reference, { action: "note", note, expectedVersion: 4 })).status).toBe(409);

    // with the first case closed, a new one may be opened for the record; the old one can't then reopen
    const second = dataOf(await createCase(root, { type: "payout", sourceId: payout.reference })).case.reference;
    const blocked = await changeCase(finance, reference, {
      action: "reopen",
      reason: "Bank says it never arrived.",
      expectedVersion: 4,
    });
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked)).toContain(second);
    expect(
      (
        await changeCase(root, second, {
          action: "dismiss",
          code: "duplicate",
          note: "Duplicate of the earlier case.",
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    const reopened = dataOf(
      await changeCase(finance, reference, {
        action: "reopen",
        reason: "Bank says it never arrived.",
        expectedVersion: 4,
      }),
    );
    expect(reopened.case).toMatchObject({ status: "open", version: 5, resolution: null });

    const audit = await (
      await collections()
    ).adminAudit
      .find({ "target.type": "case", "target.id": reference })
      .sort({ at: 1, _id: 1 })
      .toArray();
    expect(audit.map((a) => a.action)).toEqual([
      "case.create",
      "case.note",
      "case.assign",
      "case.resolve",
      "case.reopen",
    ]);
    // a note's text lives in the case, not in the audit trail
    expect(JSON.stringify(audit)).not.toContain(note);
    expect(await (await collections()).payouts.findOne({ _id: payout._id })).toEqual(payout);
  });

  it("shows a case only to roles that can see its source, and counts only those", async () => {
    const root = await rootAdmin();
    const support = await staff(root, "support_agent");
    const payout = await flaggedPayout();
    const target = await person();
    const payoutCase = dataOf(
      await createCase(root, { type: "payout", sourceId: payout.reference, priority: "urgent" }),
    ).case.reference;
    const accountCase = dataOf(await createCase(support, { type: "account", sourceId: hex(target) })).case.reference;

    expect((await getCase(support, payoutCase)).status).toBe(404);
    expect(
      (await changeCase(support, payoutCase, { action: "note", note: "Looking.", expectedVersion: 1 })).status,
    ).toBe(404);
    expect((await createCase(support, { type: "payout", sourceId: payout.reference })).status).toBe(403);

    const mine = dataOf(await call<CaseListResponse>(casesRoute, "/api/admin/cases", { cookie: support.cookie }));
    expect(mine.cases.map((c) => c.reference)).toEqual([accountCase]);
    expect(mine.counts).toEqual({ open: 1, urgent: 0, unassigned: 1 });
    const all = dataOf(
      await call<CaseListResponse>(casesRoute, "/api/admin/cases?priority=urgent", { cookie: root.cookie }),
    );
    expect(all.cases.map((c) => c.reference)).toEqual([payoutCase]);
    expect(all.counts).toEqual({ open: 2, urgent: 1, unassigned: 2 });
    expect((await call(casesRoute, "/api/admin/cases?assignee=everyone", { cookie: root.cookie })).status).toBe(400);
  });
});

// --- exceptions and dashboard ------------------------------------------------------------------

describe("booking and finance exceptions", () => {
  it("lists flagged bookings with safe fields and leaves every money record unchanged", async () => {
    const root = await rootAdmin();
    const finance = await staff(root, "finance_ops");
    const booking = await flaggedBooking();
    const payout = await flaggedPayout();
    const before = await moneySnapshot();

    const res = await call<ExceptionPage>(exceptionsRoute, "/api/admin/exceptions?kind=bookings", {
      cookie: finance.cookie,
    });
    const page = dataOf(res);
    expect(page.items).toEqual([
      expect.objectContaining({
        reference: booking.reference,
        paymentStatus: "refund_failed",
        outcome: "failed",
        category: "refund_failed",
        expectedKobo: 30_000_00,
        paidKobo: 30_000_00,
        refundStatus: "failed",
        openCase: null,
      }),
    ]);
    const text = JSON.stringify(res.json);
    for (const secret of ["14 Secret Close", "Private customer note", "fks_private_payment_reference", "Blue gate"])
      expect(text).not.toContain(secret);

    // working both through cases moves no money
    for (const [type, sourceId] of [
      ["service_booking", booking.reference],
      ["payout", payout.reference],
    ]) {
      const opened = dataOf(await createCase(finance, { type, sourceId })).case;
      await changeCase(finance, opened.reference, { action: "assign", assigneeId: hex(finance), expectedVersion: 1 });
      await changeCase(finance, opened.reference, { action: "status", status: "waiting_provider", expectedVersion: 2 });
      expect(
        (
          await changeCase(finance, opened.reference, {
            action: "resolve",
            code: "provider_informed",
            note: "Provider confirmed they will handle it on their side.",
            expectedVersion: 3,
          })
        ).status,
      ).toBe(200);
    }
    expect(
      dataOf(await call<AdminSummary>(summaryRoute, "/api/admin/summary", { cookie: finance.cookie })),
    ).toMatchObject({
      flaggedBookings: 1,
      flaggedPayouts: 1,
      openCases: 0,
    });
    expect(await moneySnapshot()).toBe(before);
  });

  it("shows a failed count as an error (null), never as zero", async () => {
    const root = await rootAdmin();
    await flaggedPayout();
    const original = Collection.prototype.countDocuments;
    const spy = vi.spyOn(Collection.prototype, "countDocuments").mockImplementation(function (
      this: Collection,
      ...args
    ) {
      if (this.collectionName === COLLECTIONS.payouts) return Promise.reject(new Error("simulated outage"));
      return original.apply(this, args as Parameters<typeof original>);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const summary = dataOf(await call<AdminSummary>(summaryRoute, "/api/admin/summary", { cookie: root.cookie }));
      expect(summary.flaggedPayouts).toBeNull();
      expect(summary).toMatchObject({ flaggedOrders: 0, failedDeliveries: 0, openCases: 0 });
      expect(JSON.stringify(errors.mock.calls)).not.toContain("simulated outage");
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });
});
