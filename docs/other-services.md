# Other Services marketplace

Farm services that any verified user can book: fumigation, recruitment,
transport, logistics, sales connection, installation and maintenance. Built on
the existing services, Paystack, wallet/ledger and notification outbox. It does
not add a new auth system, checkout, payment provider, queue or scheduler.

## Routes

| Page                       | Who                     | What                                                   |
| -------------------------- | ----------------------- | ------------------------------------------------------ |
| `/services`                | any verified user       | Directory: search, category cards, filters, pagination |
| `/services/[id]`           | any verified user       | Service details (only fields the provider filled in)   |
| `/services/[id]/book`      | anyone except the owner | Step 1 of 3: job details, date, location, contact      |
| `/services/bookings`       | customer                | My service bookings                                    |
| `/services/bookings/[id]`  | that booking's customer | Step 2 (payment), Step 3 (confirmation), tracking      |
| `/services/jobs`, `/[id]`  | provider roles          | Bookings made with me; accept, quote, progress         |
| `/services/providers/[id]` | any verified user       | Provider profile and their listed services             |
| `/profile/services`        | providers               | Unchanged: the provider's own service list and editor  |

APIs: `GET /api/service-directory`, `GET /api/service-directory/[id]`,
`GET|POST /api/service-bookings`, `GET|PATCH /api/service-bookings/[id]`,
`POST /api/service-bookings/[id]/checkout`,
`POST /api/service-bookings/[id]/verify-payment`. All need a verified session.
Identity and ownership always come from the session; no route accepts a user
id. Someone who isn't a party to a booking gets the same 404 as a missing one.

## Categories and roles

| Category         | Offered by                           |
| ---------------- | ------------------------------------ |
| Farm Fumigation  | non-vet specialists                  |
| Recruitment      | non-vet specialists                  |
| Transportation   | non-vet specialists, poultry farmers |
| Logistics        | non-vet specialists, poultry farmers |
| Sales Connection | non-vet specialists                  |
| Installation     | non-vet specialists                  |
| Maintenance      | non-vet specialists                  |

Veterinarians offer their services through Find a Vet only
(`MARKETPLACE_ROLES` in `lib/services/config.ts`). A marketplace service is an
ordinary `services` document with marketplace fields added (`pricing`,
`serviceStates`, `included`, `excluded`, `requirements`, `searchWords`). Older
services don't have these fields and never appear in the directory. A service
is listed only while it's active, has bookings switched on, isn't archived, and
its owner's account is active and still has a role that may offer that
category.

Credentials aren't required to list a service. The "Credentials verified" badge
shows only when the provider's credentials were actually verified.

## Directory

- Filters: free-text search (whole words, matched against `searchWords`),
  category, state covered, pricing (fixed or quote) and max price. A max price
  implies fixed pricing. Filters live in the address bar
  (`/services?category=…&state=…`). Unknown or invalid values redirect to the
  canonical address, and Back and Forward restore the filters.
- Keyset pagination, newest first (`createdAt`, then `_id` as the
  tie-breaker). The page size is 12 by default and capped at 24. The cursor is
  HMAC-signed and bound to the canonical filters, so a cursor reused with
  different filters is refused (400) and the client starts again from page
  one. Changing a filter always resets to page one.
- The client drops responses that arrive out of order (a sequence number plus
  `AbortController`) and de-duplicates by id when it appends a page.
- States: loading skeletons, an error with Try again, no results (with Clear
  filters), an empty marketplace, and Load more.
- Cards show only real data: category, title, price or "Quote required",
  description, states covered, duration, the provider (linked) and View, Book
  or Request quote. There are no ratings, job counts, distances or ETAs,
  because none of them exist.
- Each page is one indexed query on `services` plus one batched owner lookup
  (no N+1 queries).

## Booking workflows

Step 1 collects the category-specific fields (`CATEGORY_FIELDS`, for example
the farm size and pest for fumigation, or the load and destination for
transport), a date (tomorrow to 90 days ahead, Lagos time), a time of day, an
address in a state the service covers, optional directions, a contact
preference (call or SMS) and optional notes. The server reads the provider,
price and category from the service itself and stores a snapshot of them on the
booking, so later edits to the service don't change existing bookings.

Rules enforced by the server:

- You can't book your own service.
- A customer can have at most 5 open bookings at a time.
- A customer can have one open booking per service per day (the
  `customer_open_unique` partial unique index). There is no provider capacity
  or calendar model, so this is the only slot-conflict rule.
- Each attempt carries an idempotency key (unique per customer). The same key
  with the same details returns the existing booking; the same key with
  different details gets a 409.

**Fixed price:**

```
awaiting_payment (pay within 30 min) ──paid──► requested ──accept──► confirmed
```

The provider has 24 hours to respond, or until the start of the booked day if
that's sooner. If they don't, the booking lapses and is refunded.

**Quote:**

```
requested ──send_quote──► quote_offered ──accept_quote──► awaiting_payment ──paid──► confirmed
```

A quote is valid for 1 to 7 days (3 by default), and never past the start of
the booked day. Paying an accepted quote confirms the booking straight away,
because the provider has already agreed the price.

**After confirmation:**

```
confirmed ──► provider_en_route ──► in_progress ──► completed
```

The provider moves the booking along on the booked day. "On the way" is the
provider's own update. There is no live location and no arrival estimate.

**End states:** `declined` (by the provider), `cancelled` (by either side, with
a reason) and `expired` (lapsed).

Each transition is a single conditional update on the expected current status
(and, for payments, the expected attempt). A stale request (for example the
provider accepting a booking the customer has just cancelled) gets a 409 asking
the user to reload. Provider actions require the booking's `providerUserId` to
equal the session user, and customer actions require `customerUserId` to equal
the session user.

Phone numbers are shared only while a booking is `confirmed`,
`provider_en_route` or `in_progress`, through a `tel:` link. There is no
in-app chat.

## Payment

This uses the existing Paystack primitives (initialise and verify) through the
server. The secret key never reaches the browser.

- The amount is set by the server in integer kobo: the service's fixed price,
  or the quote the customer accepted. Nothing comes from the browser.
- **No platform or booking fee is added.** The customer pays exactly the
  service price. The UI image showed a ₦2,500 platform fee, but that is
  illustrative only and was not implemented. The seller commission (below) is
  taken from the provider's earning and is never charged to the customer.
- One active attempt per booking (the `one_active_per_booking` partial unique
  index). Checkout is idempotent: repeating it returns the open attempt's
  Paystack URL.
- Lifecycle: `initializing → open → success | failed`; `open → closed` when the
  booking ends unpaid; `initializing → superseded` when an attempt never
  reached the customer.
- Paystack sends the customer back to `/services/bookings/[id]?reference=…`.
  **The redirect proves nothing.** The page asks the server to verify. The
  booking is marked paid only when the transaction verified through the
  Paystack API matches on reference, amount, currency (NGN), booking and
  status.
- Failed or abandoned payments: the attempt is marked failed, and the customer
  can try again while the booking is still awaiting payment.
- Ambiguous results (the provider is unreachable or the status is pending)
  stay pending. They are checked again by "I've paid — check again" and by
  the background job.
- A mismatch (wrong amount or currency) is never marked paid. The booking is
  flagged with `reviewIssue` for a person to look at.
- A late success (paid after the booking lapsed or was cancelled) is refunded
  in full. Refunds are unique per payment reference
  (`one_refund_per_payment`), so nothing is refunded twice.

## Commission and ledger

`lib/server/service-ledger.ts` mirrors `order-ledger` and reuses the existing
ledger API and commission policy. Entries use the source type
`service_booking`, with the booking reference (`FK-SVC-…`) as the source id.
All calls are idempotent.

- **Earning:** recorded once the booking is paid _and_ the provider has taken
  the job (accepted it, or quoted the price that was paid) _and_ a commission
  policy is configured. Without a policy, the booking is retried by the job
  until one exists.
- **Delivery:** recorded when the provider marks the job completed. This
  starts the existing withdrawal hold window.
- **Refund:** the provider's share of a refund Paystack confirmed. An earning
  is held while a refund is in flight.
- Declined and expired bookings never earn.

## Refunds and cancellation

A full refund is created in the same transaction as the status change when a
paid booking is:

- declined by the provider;
- cancelled by the provider before the work starts (confirmed or on the way);
- cancelled by the customer while it waits for the provider, or once confirmed up to the day before the booked date
  (`cancelUntil`);
- lapsed (the provider didn't respond in time).

A customer can't cancel on the booked day itself. Partial refunds and disputes
over completed work have no UI. They need a person, and the existing admin and
support tools apply to the ledger entries.

## Background job

There is no new scheduler. `POST /api/internal/orders/process` (the existing
order job, protected by `ORDER_JOB_SECRET`) also runs `runServiceBookingJob`.
That job:

- lapses unanswered requests, expired quotes and unpaid bookings;
- re-checks pending payments and refunds;
- retries unfinished ledger updates.

Notification delivery uses the existing notification job. If the scheduler
isn't running, lapsing happens lazily when a booking is read or changed, but
pending payments and refunds won't be re-checked.

## Notifications

Each booking event is appended to the booking's `history`. Notifications are
built from history items through the existing outbox, with the event key
`service_booking:<id>:<index>:<event>`, so a retry never sends one twice.
Every write that adds history also sets `notifySyncAt`, and the notification
job finishes any that didn't send. The types are `service_booking_*`:
requested, quote_offered, quote_accepted, paid, payment_failed, confirmed,
declined, cancelled, expired, en_route, started, completed, refund_processed
and refund_failed. Links go to `/services/bookings/[id]` (customer) or
`/services/jobs/[id]` (provider). No new SMS or email provider was added.

## Data and indexes

New collections:

- `serviceBookings`
- `servicePayments`
- `serviceRefunds`

`services` gains optional marketplace fields. These changes are
backward-compatible: existing documents are unaffected.

Run `npm run db:setup` to create the indexes (`lib/server/indexes.ts`):

- **serviceBookings:**
  - `reference_unique`, `customer_idempotency`
  - `customer_open_unique` (partial)
  - `customer_recent`, `provider_recent`
  - `respond_queue`, `pay_queue`, `quote_queue`
  - `ledger_sync`, `notify_sync`
  - `flagged`
- **servicePayments:** `reference_unique`, `one_active_per_booking` (partial),
  `booking_recent`, `active_queue`.
- **serviceRefunds:** `reference_unique`, `booking`, `one_refund_per_payment`,
  `status_queue`.
- **services:** `marketplace_recent`, `marketplace_words` (both partial on
  `pricing`), alongside the existing `owner_current`.

Lists are keyset-paged (20 bookings per page; the cursor only positions within the session user's own bookings, so it isn't signed), and job
batches are bounded.

## Limitations

- No platform fee, no provider capacity or calendar, and no live tracking or
  ETAs.
- No ratings or reviews. No chat; contact is by phone once the booking is
  confirmed.
- Confirmed bookings aren't closed automatically after their date. The
  provider marks them completed.
- `reviewIssue` (payment mismatches and refunds that need attention) is logged
  and indexed, but has no admin screen yet.
- Text search matches whole words only (no stemming or fuzzy matching).
- No automated browser tests. The backend is covered by
  `tests/other-services.test.ts` (Vitest with in-memory MongoDB and a mocked
  Paystack).

## Manual checks

Use Paystack **test** keys only.

1. As a non-vet specialist, open Profile → Services and add a Fumigation
   service at a fixed price. Choose states and switch on "Customers can find
   and book this". Add a Transportation service with "Quote on request".
2. As a poultry farmer, check that only Transportation and Logistics are
   offered in the service editor. As a vet, check that no marketplace
   categories are offered.
3. As another user, open Services:
   - both services appear;
   - search, the category cards, and the state, pricing and max-price filters
     work;
   - the address updates and Back restores the filters;
   - Load more doesn't show duplicates;
   - the no-results and Clear states work.
4. Open the fixed service and check that the details show only the filled-in
   fields. Book it: try submitting it empty to see the field errors, then
   submit it valid. Paystack test checkout opens.
5. Pay with a test card. When you're sent back, the booking shows "Payment
   received" only after verification, with Paid in the history. Reloading the
   return URL doesn't double-record it.
6. Abandon a checkout and come back: the booking still shows "Awaiting
   payment", and Pay works again. Wait more than 30 minutes (or run the job):
   the booking expires.
7. As the provider, open Jobs and accept the booking. The customer sees
   Confirmed and phone numbers appear on both sides. Mark it on the way, then
   started, then completed on the booked day. The tracker and history update
   with real times.
8. Quote flow: request a quote, send a quote as the provider, then accept and
   pay as the customer. The booking is confirmed straight away. Rejecting a
   quote ends the booking with no charge.
9. Cancel a paid booking as the customer before its day: you get a full
   refund, and the refund appears in the history and notifications.
10. Try opening another user's booking URL: you get a 404.
11. Check notifications for each step, and that the bottom nav shows Services
    (and Jobs for specialists).
