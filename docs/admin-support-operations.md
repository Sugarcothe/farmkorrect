# Admin and support operations

This page covers Milestone 10, a small internal area at `/admin` where trusted staff can:

- review professional credentials;
- close order issues that buyers report;
- moderate product reviews;
- look into operational exceptions.

Every decision is written to an append-only audit trail.

It is deliberately minimal. There are no staff invitations, no impersonation and no public admin sign-up.

> **V2 update.** Admin roles, account suspension and the case centre are described in [admin-operations-v2.md](admin-operations-v2.md). Admins in `ADMIN_USER_IDS` below are now *root Super Admins*. Super Admins can grant narrower roles (Support Agent, Trust & Safety, Finance Ops, Content Manager) at `/admin/team`, and each page and API below now requires a specific capability. Where this page says "an admin", read "an admin whose role allows it".

## Who is an admin

Admin access comes from **one place only**: the server-side environment variable `ADMIN_USER_IDS`. It is a comma-separated list of MongoDB user ids (24 hex characters each):

```
ADMIN_USER_IDS=<id>,<id>
```

- **No admins by default.** If the variable is absent or empty, nobody can use `/admin`. There is no bootstrap account and no "first user is admin" rule, and registration never grants admin access.
- **Malformed means nobody.** One bad entry (not an id, a stray separator, quotes, a trailing comma) disables admin access entirely, instead of half-applying the list. The server logs a warning that names the problem but not the ids.
- **Server-only.** Never prefix it with `NEXT_PUBLIC_`. The ids are never sent to the browser or included in any response.
- **The session must be fully signed in.** An allowlisted account also needs a full session (not the pending-verification session from registration), an `active` account and a verified phone number. If any of these is missing, the account is treated as a normal user.
- **Nothing from the browser counts.** Roles, `isAdmin` flags, user ids in the query string or body, cookie fields and local storage are all ignored. The server checks the session against the allowlist on every admin page, every admin API read and every admin action. Admin actions also require a same-origin request.
- **Failed checks look like a missing page.** A signed-in non-admin gets the normal 404 page (API: `404 Not found`). Someone who isn't signed in is sent to sign in (API: `401`). Neither reveals that an admin area exists or who the admins are.

The profile page shows an **Admin** row only when the server has confirmed the current user is an admin.

### Adding an admin

1. **Confirm who you are granting access to.** Ask the person to sign in, and verify their identity through a channel you already trust (in person, or a known phone number). Don't act on an email or chat message alone. An admin can approve credentials and release sellers' held earnings.
2. Find their user id in MongoDB. Look the account up by its normalized phone number in the `users` collection and copy `_id` as a hex string. Check that the account is `active` with a verified phone number.
3. Add the id to `ADMIN_USER_IDS` in the deployment's environment (for example Vercel → Settings → Environment Variables) and redeploy or restart. For local work, put it in `.env.local`. Never commit an id list to the repository.
4. Ask them to open Profile → Admin to confirm it works.

### Removing an admin

Remove their id from `ADMIN_USER_IDS` and redeploy or restart. Access ends on the next request after the new value is live, because every page and API call re-checks it. Their past decisions stay in the audit trail. If the account itself may be compromised, also sign them out by deleting their documents in the `sessions` collection.

## Routes

| Page | API | What it does |
|---|---|---|
| `/admin` | `GET /api/admin/summary` | Counts for each queue, plus the five most recent admin actions |
| `/admin/credentials` | `GET /api/admin/credentials` | Credential submissions waiting for a decision, oldest first |
| `/admin/credentials/[userId]` | `GET`, `POST /api/admin/credentials/[userId]` | One submission with its history; approve or reject |
| `/admin/issues` | `GET /api/admin/issues?state=open\|closed` | Order issues (open: oldest report first) |
| `/admin/issues/[number]` | `GET`, `POST /api/admin/issues/[number]` | One issue with its history; close it |
| `/admin/reviews` | `GET /api/admin/reviews?status=pending\|published\|rejected` | Reviews by status |
| — | `POST /api/admin/reviews/[id]` | Publish, reject, remove or restore a review |
| `/admin/exceptions` | `GET /api/admin/exceptions?kind=orders\|bookings\|payouts\|deliveries` | Read-only operational exceptions |
| `/admin/team` | `GET`, `POST /api/admin/team`, `POST /api/admin/team/lookup`, `GET`, `POST /api/admin/team/[userId]` | Admin roles (V2) |
| `/admin/users` | `GET /api/admin/users`, `POST /api/admin/users/lookup`, `GET /api/admin/users/[id]`, `POST /api/admin/users/[id]/status` | Account lookup, suspend and reactivate (V2) |
| `/admin/cases` | `GET`, `POST /api/admin/cases`, `GET`, `POST /api/admin/cases/[reference]` | Case centre (V2) |
| `/admin/audit` | `GET /api/admin/audit?action=&targetType=&targetId=&actor=&page=` | The audit trail, newest first |

- **Pagination.** Lists show 20 per page (`?page=`).
- **Projections.** Responses are built from explicit field lists. Whole database documents are never sent to the browser.
- **Rate limits.** Reads are limited to 600 per admin per 15 minutes, and actions to 300 per admin per hour.
- **No edits or deletes.** No admin route accepts `PATCH`, `PUT` or `DELETE`. The audit trail can only be read.
- **Unknown values.** Fields, filters and states that aren't listed above are rejected with `400`.

## Workflows

### Credential review

When a veterinarian or non-vet specialist saves a registration number in Edit Profile, their credential status becomes **pending** and the submission appears in the queue.

- **Approve** sets the status to `verified`. **Reject** sets it to `rejected` and **requires a reason** (5–500 characters). The reason is stored only in the audit trail. The professional is told the outcome in-app, but never the reason.
- **What approval means.** It records that *an admin reviewed the submitted details and accepted them*. **Farm Korrect does not check credentials against any external licence register.** Approval is not proof of licensure. Admins should do whatever checks your policy requires (for example, the VCN register) before approving.
- **Only pending submissions can be decided.** A credential that was never submitted can't be approved.
- **Stale decisions are refused.** The form sends the submission time it was shown. If the professional resubmitted in the meantime, or another admin already decided, the request gets `409` and nothing changes. Of two simultaneous decisions, exactly one succeeds.
- **No self-review.** Admins can't decide their own credentials (`403`).
- **The actor** is always the signed-in admin from the session.

### Closing an order issue

A buyer can report a problem within 24 hours of delivery. While the issue is open, the seller's earning for that order is **held** (shown as "Under review" in their wallet).

On `/admin/issues/[number]` an admin can close the issue. Closing needs:

- a **resolution note** (10–1000 characters, internal); and
- ticking the confirmation box. The API requires `"confirmed": true`.

**What closing does:**

- It **releases the seller's held earning** through the existing ledger flow (`closeIssue` in `lib/server/orders.ts`). The earning becomes available or paid out on the normal schedule.
- It **does not refund the buyer**, change the payment status or touch Paystack. If the buyer should get money back, the seller issues a refund from the sale *before* the issue is closed, using the existing post-delivery refund flow. Admins can't move money directly.
- The buyer and seller each get the existing "issue resolved" notification. The note is not included.
- The note, the closing admin and the time are stored on the order (`issue.resolution`). They are never included in the buyer's or seller's view of the order.
- The order update, the earning release and the audit record are committed **in one transaction**. If the audit record can't be written, nothing changes.
- An already-closed issue gets `409`. Two simultaneous closes release the earning once.
- Admins can't close issues on orders where they are the buyer or the seller (`403`).

The internal endpoint `POST /api/internal/orders/issues` (with `Authorization: Bearer <ORDER_JOB_SECRET>`) still works for automated support tooling. Its closes go through the same function and are audited with no actor (`actorUserId: null`, shown as "System").

### Review moderation

Reviews are published as soon as they are written. Moderation can move them between these states:

| Action | From | To | Reason |
|---|---|---|---|
| Publish | pending | published | optional |
| Reject | pending | rejected | required |
| Remove | published | rejected | required |
| Restore | rejected | published | required |

- **Nothing else changes.** Moderation never changes a review's rating or text and never deletes it.
- **Withdrawn reviews are off limits.** A review its author withdrew stays `withdrawn`, and moderation can't change it.
- **Stale or invalid moves are refused** (`409`). The form sends the review's `updatedAt`, and a move that doesn't fit the review's current status is rejected. Of two simultaneous moves, one succeeds.
- **No conflicts of interest.** Admins can't moderate reviews of their own products or reviews they wrote (`403`). The list says so instead of showing the buttons.
- **Visibility to the author.** Authors see the new status under *My Reviews* and get an in-app notification. The reason stays internal.
- **Ratings.** After each move, the product's `ratingCount` and `ratingAverage` are recalculated. The status change and audit record are committed first. If the recalculation then fails (for example, the database drops out at that moment), the moderation still stands and the request reports an error. Run `npm run db:rebuild-search` to recompute every product's rating from its published reviews.

### Operational exceptions (read only)

`/admin/exceptions` lists problems that need a person to investigate. **There are no action buttons**: nothing there retries, refunds, pays out or changes the ledger.

- **Orders** flagged during payment checks (`reviewIssue`, for example an amount or reference mismatch). Shows the order number, total, statuses and the flag text. Buyer contact details and delivery notes are not shown.
- **Service bookings** (V2) flagged with an exception, with the latest refund record's status.
- **Payouts** flagged with an `issue`. Shows the reference, amount, status, failure reason, bank name and **only the last four digits** of the account. Recipient codes, transfer codes, raw provider statuses and responses are never shown.
- **Deliveries.** Notification deliveries (email, SMS, push) that failed or exhausted their retries. Shows the channel, attempts and a short failure code, not message contents or provider ids.

## Audit trail

Every credential decision, issue close and moderation move writes one record to the `admin_audit` collection. Each record contains:

- `actorUserId`, or `null` for the internal job;
- `action`;
- `target` (`{ type, id }`);
- `reason` or note;
- `from` / `to` state;
- `at`.

**What it never contains:** passwords, session tokens, API keys, bank details, payment payloads or contact details.

- **Transactional.** The record is written in the same transaction as the change it describes, so a change can't happen without its record.
- **Append-only.** The app only inserts records. No API, page or helper updates or deletes them.
- **Access.** Only admins can read the trail: at `/admin/audit` with filters, and in each case's history.
- **Indexes.** `npm run db:setup` creates the `admin_audit` indexes (recent; by action; by target; by actor). Run it after deploying this milestone.
- **Retention.** Records are kept indefinitely. There is no TTL index, because no retention period has been decided. When one is, add a policy deliberately rather than deleting by hand. Database administrators with direct MongoDB access can still change the collection; restrict that access accordingly.

## Notifications

The decisions use the existing notification system: in-app records written through the outbox, deduplicated by event key. They create:

- `credential_verified` / `credential_rejected`;
- `review_approved` / `review_removed`;
- for an issue close, the existing `issue_resolved` (buyer) and `sale_issue_resolved` (seller).

The new types are in-app only. Admin actions don't promise email or SMS. Those channels are only used where a user has enabled them and a provider is configured.

## Setup checklist

1. Deploy, then run `npm run db:setup` against the production database to create the new indexes.
2. Set `ADMIN_USER_IDS` (see "Adding an admin" above) and redeploy.
3. Keep `ORDER_JOB_SECRET` set if you use the internal issue endpoint. It is never sent to the browser.

## Known gaps

- Credential approval is a manual judgement. There is no integration with an external licence register.
- There is no admin-initiated refund. Refunds still come from the seller's post-delivery refund flow.
- Exceptions are read-only. Resolving them means checking Paystack and the records, then acting through the existing flows or support tooling.
- New admin decisions notify in-app only.
- If recalculating a rating fails after a moderation move, someone has to run `npm run db:rebuild-search`. There is no automatic retry.
- No audit retention policy or export yet.
- ~~All admins have the same powers.~~ Roles and capabilities arrived in V2 ([admin-operations-v2.md](admin-operations-v2.md)).
