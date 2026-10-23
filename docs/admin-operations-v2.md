# Admin operations V2: permissions, accounts and cases

V2 extends the admin area described in [admin-support-operations.md](admin-support-operations.md) with four things:

- **Granular admin roles.** Each role holds a fixed set of capabilities, enforced on the server.
- **`/admin/team`.** Super Admins grant, change and revoke roles on existing accounts.
- **`/admin/users`.** Exact account lookup, plus suspend and reactivate.
- **`/admin/cases`.** Internal case records for investigating flagged orders, bookings, payouts, failed deliveries, order issues and accounts.

The exceptions view also gains service-booking exceptions and clearer finance outcomes.

**Out of scope, deliberately:**

- moving money: refunds, payouts, retries or ledger edits;
- impersonation, password or OTP viewing, account deletion and account creation;
- invitations;
- a raw database browser.

## Who is an admin

Admin access is decided on the server, on every page load, API read and action, from two sources:

1. **Root admins: `ADMIN_USER_IDS`.**
   - This is the existing server-only allowlist. It is unchanged, and it is still the only way to bootstrap access.
   - Every listed account is a **Super Admin** and is marked *root*.
   - Root admins can't be granted, changed, revoked or suspended from the app. The way back in can't be lost from inside the app.
   - If the list is empty or malformed, **nobody is an admin at all, granted roles included**. The check fails closed, as before, so a broken configuration can't leave granted roles running with nobody able to manage them.
2. **Granted roles: the `admin_memberships` collection.**
   - A Super Admin gives an existing account one role at `/admin/team`.
   - An account holds at most one active role. A unique partial index on `userId` where `status: "active"` enforces this.
   - Revoked memberships are kept as history.

Both sources also require all of the following:

- a full (not pending-verification) session;
- an `active` account;
- a verified phone number.

If any of these is missing, the account gets no admin access at all.

**Fail closed.** The capability check returns no access in all of these cases:

- the role is unknown;
- the membership document is malformed;
- the account is suspended;
- the database read throws (the request fails with a generic error, never with access).

It never falls back to a default role.

**Nothing from the browser counts.** All of these are ignored:

- roles, `isAdmin` flags and permission arrays;
- user ids in the query string or body;
- cookie fields and local storage.

The pages receive the viewer's role and capabilities only for display. Every server route checks them again.

**Responses:**

| Who | Admin pages | Admin API |
|---|---|---|
| Not signed in | Sent to sign in | `401` |
| Signed in, no admin role | Normal 404 page | `404` |
| Admin without the capability | 404 page | `403` |

`/profile` shows the **Admin** row only after the server confirms that the viewer holds an admin role.

## Capability matrix

| Capability | What it allows | Super Admin | Support Agent | Trust & Safety | Finance Ops | Content Manager |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `admin.team.manage` | Grant, change and revoke admin roles | ✓ | | | | |
| `admin.users.read` | Look up accounts (masked) | ✓ | ✓ | ✓ | | |
| `admin.users.suspend` | Suspend and reactivate accounts | ✓ | | | | |
| `admin.cases.read` | See cases (of types whose source they can see) | ✓ | ✓ | ✓ | ✓ | |
| `admin.cases.manage` | Open cases, add notes, work cases that are theirs or unassigned | ✓ | ✓ | ✓ | ✓ | |
| `admin.cases.assign` | Assign any case to anyone, work any case | ✓ | | | | |
| `admin.credentials.review` | Approve or reject credentials | ✓ | | ✓ | | |
| `admin.reviews.moderate` | Moderate product reviews | ✓ | | ✓ | | |
| `admin.order_issues.read` | See reported order issues | ✓ | ✓ | | ✓ | |
| `admin.order_issues.resolve` | Close order issues (releases the held earning through the existing ledger rules) | ✓ | | | ✓ | |
| `admin.exceptions.read` | Flagged orders, service bookings and payouts | ✓ | | | ✓ | |
| `admin.deliveries.read` | Failed email, SMS and push deliveries | ✓ | ✓ | | | |
| `admin.analytics.read` | Marketplace and financial reports | ✓ | | | ✓ | |
| `admin.training.manage` | Training courses | ✓ | | | | ✓ |
| `admin.audit.read` | The whole audit trail | ✓ | | | | |

The matrix lives in `lib/admin/permissions.ts`. Server checks go through `requireAdminCapability` (API) and `requireAdminCapabilityPage` (pages) in `lib/server/admin.ts`.

Two further rules apply:

- **Super Admin is root-only.** Only a root admin can grant, change or revoke the Super Admin role, or suspend a Super Admin.
- **Case visibility follows the source.** A case of a given type is visible only to admins who can see that type's source (for example, payout cases need `admin.exceptions.read`). Otherwise the case returns 404.

## Admin team (`/admin/team`)

**Who:** Super Admins (`admin.team.manage`).

**What the page shows:**

- every active admin, with their role, whether they're root, who granted the role and when;
- recently revoked roles;
- a description of each role.

**Granting a role:**

1. Search with an exact user id, phone number or email.
   - The search is a `POST`, so contact details never appear in URLs or access logs.
   - It is rate limited (60 lookups per admin per 15 minutes).
2. The result shows masked contact details. Granting is blocked for:
   - yourself;
   - a root admin;
   - an inactive account;
   - an account without a verified phone number.
3. Choose a role and give a reason. The grant and its `membership.grant` audit record are written in one transaction.

**Changing or revoking a role:**

- Each change carries `expectedVersion`. A stale version returns `409`.
- Nobody can change their own role.
- Access ends on the account's next request.
- Each change is audited (`membership.change` / `membership.revoke`).

**Not included:**

- invitations;
- account creation;
- any admin list visible to non-admins.

The team API returns `404` to non-admins and `403` to other admin roles.

## Accounts (`/admin/users`)

**Who:** `admin.users.read` to look up; `admin.users.suspend` to change status.

**Lookup:**

- Lookup is exact: one user id, phone number or email per request, sent by `POST`. There is no browsing or partial-match search of users.
- Results show only masked details:
  - the phone number's last digits;
  - the first letter and the domain of the email;
  - role, status, join date, order counts and the account's admin-action history.
- Never shown: passwords, OTPs, sessions, bank details and payment data.
- The page also lists suspended accounts, paginated, 20 per page.

### Account status model

| Status | Meaning | Set by |
|---|---|---|
| `pending_verification` | Registered, phone not yet verified | Registration |
| `active` | Normal account | Phone verification, or an admin reactivating |
| `suspended` | Can't sign in or use the app | An admin with `admin.users.suspend` |

**Suspending an account** requires all of the following:

- a reason (recorded in the audit trail, never sent to the user);
- an explicit confirmation;
- the `expectedVersion` the admin was looking at.

These changes happen in **one transaction**:

- the status becomes `suspended` and `statusVersion` is incremented;
- every session is revoked, so the user is signed out on their next request;
- outstanding password-reset links are invalidated;
- any active admin role is revoked;
- the `user.suspend` audit record is written, plus `membership.revoke` if a role was revoked.

After the transaction commits, the user is notified through the outbox: an in-app record, plus email or SMS where configured, because they can no longer sign in to read it. The notice never includes the reason or internal notes.

A suspended account that tries to sign in gets `403`, and only after the password check, so the response doesn't reveal account state to someone without the password.

**Suspension does not change:**

- orders, bookings or payouts;
- ledger entries or wallet balances;
- credentials or reviews.

**Reactivating an account:**

- It needs a reason and the expected version.
- It sets the status back to `active` and notifies the user (again without the reason).
- It **restores nothing that suspension revoked.** The user signs in again, password-reset links stay invalid, and an admin role has to be granted again deliberately.

**Restrictions:**

- An admin can't suspend themselves, and root admins can't be suspended from the app (`403`).
- There is no impersonation, password viewing, deletion or role change for ordinary user roles.

## Cases (`/admin/cases`)

A case is an internal record of an investigation into something that already exists.

**Types:** `order_payment`, `service_booking`, `payout`, `notification_delivery`, `order_issue` and `account`.

**Opening a case never changes its source.** Resolving a case records what the investigation found, not that money moved.

**Creating a case:**

- Who: `admin.cases.manage` or `admin.cases.assign`, plus visibility of the type.
- Cases are opened from the exceptions view, account pages and the case API.
- The source must exist (`404` otherwise) and must currently be flagged (`409` otherwise). For example: an order with a review flag, a booking with an exception, a payout with an issue, a failed delivery, or a reported order issue. Any existing account can have an account case.
- **One open case per source.** An open case stores `sourceKey` (`type:id`), which has a unique partial index. Closing a case unsets it.
  - A second create for the same source returns `409` with the existing reference.
  - Two admins clicking at the same moment can't create duplicates.
- **References** look like `FKC-` followed by 8 characters from an unambiguous alphabet.

**Case fields:**

- type, source, title;
- priority: low, normal, high, urgent;
- status: open, in progress, waiting on customer, waiting on provider, resolved, dismissed;
- assignee;
- append-only notes, up to 200 per case;
- resolution code and note;
- `version`.

**Changes:** assign, priority, status, note, resolve, dismiss and reopen.

- **Optimistic concurrency.** Every change sends `expectedVersion`. The update matches `{ _id, version }` and increments `version`. If anything changed in between, the request returns `409` and nothing is written.
- **Who may work a case.**
  - `admin.cases.assign` holders can work any case and assign it to any eligible admin (one who can see that type).
  - `admin.cases.manage` holders can add notes to any visible case. They can work cases that are assigned to them or unassigned, and can take or release a case for themselves.
- **Closing.** Resolving and dismissing need a resolution code and a note. Resolution codes describe the outcome of the investigation only; none of them performs an action.
- **Closed cases** accept only *reopen*. Reopening:
  - needs a reason;
  - fails with `409` if another case is already open for the same source;
  - is audited (`case.reopen`).
- **Audit.** Every change writes its audit record (`case.create`, `case.assign`, `case.priority`, `case.status`, `case.note`, `case.resolve`, `case.dismiss`, `case.reopen`) in the same transaction. Note audit records hold only the case reference, not the note text.
- **Source facts are read live** and projected to a privacy-safe set. Buyer contact details, delivery notes, recipient codes and provider payloads are never shown.
- **The list:**
  - open or closed;
  - filters: status, type, priority, assignee (`me`, `none` or an id);
  - pagination: 20 per page, using indexed sorts (open: most urgent then oldest; closed: most recently updated);
  - counts: open, urgent (high and urgent), unassigned.

## Exceptions: bookings and finance

`/admin/exceptions` has four tabs, each shown only with its capability:

- **Orders, Services and Payouts:** `admin.exceptions.read`.
- **Deliveries:** `admin.deliveries.read`.

Every row links to its open case, or offers **Open case**.

- **Orders.** Each row shows:
  - the expected total and the amount actually recorded as paid, kept separate;
  - a sanitized category (for example paid amount doesn't match, totals don't add up, refund failed, unexpected provider status, other), never the raw flag text;
  - an outcome: confirmed, failed, in progress, or *outcome unknown* (ambiguous).
- **Service bookings.** Flagged Other Services bookings show:
  - the booking reference, statuses and expected amount;
  - the latest refund record's status;
  - the sanitized issue.
- **Payouts.** Each row shows:
  - the amount and a sanitized failure category;
  - the outcome (confirmed, failed, in progress or outcome unknown, derived from the recorded provider status without exposing it);
  - the bank name and **only the last four digits** of the account.
- **Not shown:** recipient codes, transfer codes, raw provider responses and secrets.

**There are no money buttons anywhere.** Nothing retries, refunds, pays out or edits the ledger. The tests check that browsing exceptions and working cases leave orders, bookings, payouts, refunds and ledger entries byte-for-byte unchanged.

## Dashboard

`/admin` shows only the tiles and links the viewer's capabilities allow. Each count is fetched separately:

- If a count fails, its tile says **Couldn't load** and an alert is shown. It never shows `0`.
- The summary API returns `null` for that field, and omits fields the viewer may not see.
- Recent admin actions appear only with `admin.audit.read`.

## Audit

V2 adds these actions to the append-only `admin_audit` collection:

- `membership.grant`, `membership.change`, `membership.revoke`;
- `user.suspend`, `user.reactivate`;
- `case.*`.

Each record is written in the same transaction as the change it describes. No route, page or helper updates or deletes audit records.

**Limitation:** the app can't stop someone with direct MongoDB access from editing collections, including `admin_audit`. Restrict database credentials to the deployment and a small number of operators, and use your database host's own access logging.

## Database setup

Run `npm run db:setup` after deploying. It is idempotent and creates only these new indexes:

| Collection | Index | Why |
|---|---|---|
| `users` | `suspended_recent` (`suspension.at`, `_id`; partial on `status: "suspended"`) | The suspended-accounts list without scanning all users |
| `admin_memberships` | `user_active_unique` (unique `userId`, partial on active) | One active role per account; the per-request role lookup |
| `admin_memberships` | `status_recent`, `user_history` | The team list, and one account's role history |
| `admin_cases` | `reference_unique` | Case URLs |
| `admin_cases` | `open_source_unique` (unique `sourceKey`, partial) | At most one open case per source, even under races |
| `admin_cases` | `queue`, `type_queue`, `assignee_queue`, `status_queue` | Filtered, paginated case lists in priority order |
| `admin_cases` | `source` | Linking exceptions and accounts to their open case |

No existing index is changed or dropped.

## Rate limits

| Limit | Applies to |
|---|---|
| `adminReadsPerUser` (600 per 15 min) | Admin pages and list reads |
| `adminActionsPerUser` (300 per hour) | Every admin action |
| `adminUserLookupsPerUser` (60 per 15 min) | Account and team lookups, and account detail pages |

## Manual checklist

Run this on a staging deployment with test accounts. This hasn't been done in a browser as part of this change.

1. **Database.** Run `npm run db:setup` and confirm that the indexes above exist.
2. **Root admin.** Sign in as a root admin (in `ADMIN_USER_IDS`). The dashboard shows every tile, and `/admin/team` lists you as *Super Admin · root* with no change form.
3. **Support Agent grant.** Grant a test account *Support Agent* with a reason. As that account:
   - `/admin/users`, `/admin/cases` and the deliveries tab work;
   - the orders/payouts tabs, `/admin/team`, `/admin/credentials`, analytics and the audit trail return 404;
   - a direct API call returns `403`.
4. **Role change.** Change the role to *Finance Ops* using the version shown, then submit the old form again. You get *changed since you loaded it* (409).
5. **Revoke.** Revoke the role. On the account's next request, `/admin` returns 404 and Profile no longer shows Admin.
6. **Suspend.** Suspend a test user with a reason and the confirmation box ticked.
   - Their open session is signed out.
   - Signing in shows the suspended message.
   - They get an in-app notice without the reason.
   - The audit trail has `user.suspend`.
7. **Reactivate.** Reactivate the user. They can sign in again, and any admin role they had is **not** back.
8. **Self and root protection.** Try to suspend yourself or a root admin. The form isn't offered, and the API returns `403`.
9. **Create a case.** On a flagged order in exceptions, click **Open case**. Click it again in another tab, and the second click links to the existing case.
10. **Work a case.** Assign it, change priority and status, and add a note. Submit a change from a stale tab and expect a 409.
11. **Resolve and reopen.** Resolve the case with a code and note. Reopen it with a reason. Check the history and audit entries.
12. **No money mutations.** Throughout, confirm that no order, booking, payout, refund or wallet balance changed.

## Deployment

1. Deploy the branch.
2. Run `npm run db:setup` against the production database.
3. Keep `ADMIN_USER_IDS` as it is. Existing admins become root Super Admins with the same access they had.
4. Grant narrower roles at `/admin/team` as needed, then consider shrinking `ADMIN_USER_IDS` to one or two break-glass accounts.

## Known gaps

- A role grant has no expiry. Review `/admin/team` periodically.
- Case notes and assignments are in-app only. There are no email alerts to assignees.
- There are no SLA timers or automatic escalation.
- There is no audit export or retention policy yet.
