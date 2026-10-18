# Find a Vet: directory, profiles, appointments and tracking

Customers search veterinarians who are approved and listed. They open a vet's profile, request a visit for one of the vet's services at an open time, and follow the request until it is completed. Vets set their own hours and answer requests from **Jobs**. Every screen shows stored state only: the app has no invented vets, ratings, prices, slots, coordinates, distances, payments or arrival times.

## Screens (and where they depart from the design)

| Design screen | Route | Notes |
| --- | --- | --- |
| find-a-vet | `/vets` | Search, filters, quick-filter chips, removable active-filter chips with **Clear all**, and **Load more**. The **Map view** toggle and the **Distance** and **Rating** chips are left out (see *Location* and *Ratings*). The quick chips are real filters: works today, poultry medicine, vaccination, emergency visits. |
| vet-profile | `/vets/[id]` | Stat tiles show experience, number of services and working days, not engagements or rating. There is no **Call** button because the vet's phone is never public (see *Privacy*). |
| select-service → review-booking | `/vets/[id]/book` | Five steps with a progress bar. The calendar only lets you pick days inside the 30-day window on the vet's working weekdays; open times are fetched for the day you pick and grouped into Morning and Afternoon. The farm profile tiles (poultry type, flock size) come from the customer's own farm. The review button says **Send request**, not **Confirm & Pay**, because the app collects no payment (see *Payment*). |
| booking-confirmation | step 5 of the same page | Shows the appointment exactly as the server stored it: a pending request reads **Request sent** with an amber clock, never **Booking Confirmed!**. |
| booking-tracking | `/appointments/[id]` | Status headline, the actions this viewer may take, booking progress with times, and history. There is no map or ETA (see *Tracking*). |
| — | `/appointments`, `/jobs`, `/availability` | The customer's list, the vet's list, and the vet's availability settings. |

## Data model

| Collection | What it holds |
| --- | --- |
| `users` (existing) | The vet's identity, profile, `credentialStatus` and phone. `credentialStatus` changes only through the existing admin credential review, which is audited. |
| `services` (existing) | The vet's services, each with price, duration, `active` and `bookingAvailable`. |
| `vet_availability` | One per vet: `listed`, `state`, `area`, weekly `hours` (minutes after midnight, Lagos time, on a 30-minute grid), `slotMinutes` (30 or 60), `blockedDates`, `sharePhoneWithClients` and `directoryRefreshedAt`. |
| `vet_directory` | A derived, rebuildable search index, one entry per veterinarian. It holds `listed`, name and `nameKey`, specialization, experience and `experienceKey`, state and area, service categories, lowest price, hours, `workDays` and `blockedDates`. |
| `appointments` | Snapshots of service (name, category, duration), price (`priceKobo`, `feeKobo`, `totalKobo`) and location. Also `bookingStatus`, `paymentStatus`, `history[]` (status, actor role, time, note), `respondBy`, `idempotencyKey`, `reference`, plus the notification outbox fields `notifiedThrough` and `notifySyncAt`. |
| `appointment_slots` | One document per 30-minute unit of a vet's time held by an appointment. A unique `(vetUserId, startsAt)` index means two appointments can never hold the same unit. |

Booking status and payment status are separate fields.

## Who is listed (verification)

A vet appears in the directory, has a profile and can be booked only when all of these are true:

- the role is `veterinarian`;
- `profile.credentialStatus === "verified"`, which only the admin credential review sets. A missing or unknown value counts as not verified;
- the vet has turned listing on and chosen a state and working hours;
- the vet has at least one service that is active and open for booking.

`listingIssues()` in `lib/server/vet-directory.ts` returns the reasons a vet isn't listed. The availability page shows those reasons to the vet.

The profile and the booking path read the source collections, not the directory. A stale directory entry therefore can't make someone bookable.

The badge reads **Reviewed by Farm Korret**. The profile says plainly that this is not a live check against the Veterinary Council of Nigeria register. The registration number, qualifications and documents are never shown.

The directory entry is rebuilt after every change to the vet's account, services or settings. If that rebuild fails, the change still stands, and the scheduled job refreshes the oldest entries on every run.

## Directory search and pagination

`GET /api/vets` needs a verified session. It is rate-limited to 300 requests per 15 minutes per user and sends `Cache-Control: no-store`.

| Parameter | Values |
| --- | --- |
| `q` | Up to 5 words of at least 2 characters each. Each word must prefix-match a word of the vet's name, specialty, services or area. |
| `state` | A Nigerian state slug. |
| `specialty` | A veterinary specialization. |
| `service` | A veterinary service category. |
| `date` | `YYYY-MM-DD`, inside the booking window. Returns vets whose weekly hours include that weekday and who don't have that date blocked. Open times are checked on the profile. |
| `sort` | `experience` (default: most years first, unknown last) or `name`. |
| `limit` | 1–24. The default is 12. |
| `cursor` | The `nextCursor` value from the previous page. |

The response is `{ vets, nextCursor }`, with no total count. An unknown value for any parameter returns 400 with field errors.

**Keyset paging.** Every filter goes into the MongoDB query before the cursor and the limit. The order is always `(experienceKey desc, _id asc)` or `(nameKey asc, _id asc)`, so `_id` breaks ties and no row repeats or goes missing between pages. Each page reads `limit + 1` entries to decide whether there's a next page, plus one batch query of slot holds to compute each card's next open time. There are no per-vet queries.

**Cursor.** A cursor is base64url JSON `{v, k, i}` (the sort key and the `_id`) followed by an HMAC. The HMAC is computed with the server's auth secret and covers the canonical filters and sort. A cursor used with other filters or another sort, with an edited body or signature, or one that is malformed or oversized, gets a 400: "This list has changed. Start the search again." The page size is not part of the signature, so changing `limit` mid-list is allowed.

**Data changing during a traversal.** Pages continue strictly after the last row seen:

- A vet inserted or moved behind the cursor is not shown in this traversal.
- A vet moved ahead of it can appear once more on a later page. The browser removes duplicates by id.
- A vet who stops being listed simply drops out.

No page ever repeats a row it has already returned.

**In the browser.** Filters live in the address bar (replaced, not pushed) and are re-read by the server when you come back from a profile. Any filter or sort change resets the cursor. A newer search aborts the older request, and a late reply is ignored. **Load more** is disabled while loading. Loading, empty, no-match and retryable error states all exist.

## Indexes

Run `npm run db:setup`. It creates every index, and it is safe to run again.

| Collection | Index | Purpose |
| --- | --- | --- |
| `vet_directory` | `listed_experience` `{listed, experienceKey:-1, _id}` | Experience sort. |
| `vet_directory` | `listed_name` `{listed, nameKey, _id}` | Name sort. |
| `vet_directory` | `listed_state_experience`, `listed_state_name` | The state filter with each sort. |
| `vet_directory` | `search_words` | Word-prefix search. |
| `vet_availability` | `directory_refresh` `{directoryRefreshedAt}` | The job's stalest-first refresh. |
| `appointments` | `reference_unique` (unique) | Booking references. |
| `appointments` | `customer_idempotency` (unique) `{customerUserId, idempotencyKey}` | Idempotent booking retries. |
| `appointments` | `customer_recent`, `vet_recent` `{…, startsAt:-1, _id:-1}` | The customer and vet lists. |
| `appointments` | `customer_status` | The open-appointments cap. |
| `appointments` | `status_respond_by` | Expiry. |
| `appointments` | `notify_sync` (partial) | The notification outbox. |
| `appointment_slots` | `vet_unit_unique` (unique) `{vetUserId, startsAt}` | Database-level double-booking prevention. |
| `appointment_slots` | `appointment` | Releasing an appointment's holds. |

## Location (no map, no distance)

Farms store a free-text location, and vets store a state and area. There are no coordinates, so the app can't truthfully show distance or "near you", draw pins, or sort by proximity.

The decision was not to add a paid or third-party map provider or a geocoder, and not to draw a decorative map that looks like real data. "Near me" is the **State** filter, which the customer sets to their farm's state; that is the manual fallback.

The app never asks the browser for its location. A future version could add coordinates only after a user action and with consent, and would need a geocoder or a "drop a pin" flow. That is out of scope here.

## Booking

**Times.** All times are Lagos time (UTC+1, no daylight saving). Rules from `BOOKING_RULES` in `lib/vets/schedule.ts`:

- At least 2 hours' notice, and no more than 30 days ahead.
- A time must start on the vet's `slotMinutes` grid inside their hours for that weekday.
- The whole visit must end by closing time.
- The day must not be blocked.
- The visit's length is rounded up to 30-minute units. A service with no fixed duration takes one slot.

**Server checks** (`POST /api/appointments`, verified session, same origin, 20 per hour per user). The customer is the session user; no user id is read from the body. The server reads the service and its vet from the database and checks:

- the service is active and open for booking, and its vet is a listed, verified veterinarian;
- the customer isn't the vet;
- a `farmId`, if given, belongs to the session user (the farm name is then copied from the farm);
- the time passes the rules above.

Any price, fee, total, status, payment or user-id field in the body is ignored. Price and duration are snapshots taken from the service at that moment, so later edits to the service don't change existing bookings. A customer can have at most 10 open appointments.

**Atomic reservation.** In one transaction the server inserts the appointment and one `appointment_slots` document for each 30-minute unit. If any unit is already held, the unique index fails the insert, the transaction rolls back, and the customer gets 409 "That time is no longer available. Please choose another." The time is also re-checked when **Continue** is pressed in the wizard. The 409 from the server is the authoritative answer.

**Idempotency.** The wizard creates a UUID `idempotencyKey` per attempt and makes a new one when the service or time changes.

- Repeating a request with the same key returns the first appointment (200).
- The same key with a different service or time returns 409.
- Keys are scoped to the customer.

**Price breakdown.** The breakdown shows the service price, a booking fee of ₦0 (no fee exists) and the total, all in kobo from the snapshot.

## Payment

No payment is collected in the app for vet visits. The seller wallet is not used as a buyer wallet, no ledger entry types were added, and Paystack is not called.

- A free service (₦0) has `paymentStatus: "not_required"`.
- A priced service has `paymentStatus: "payment_required"`. The page says that nothing is charged in the app and that the customer agrees payment with the vet once they accept.

`isFullyConfirmed()` is true only when the booking is accepted (`confirmed`, `en_route` or `in_progress`) **and** payment is `not_required`. Only then does any screen or notification say "Booking confirmed". A priced visit the vet has accepted reads "Accepted" or "Vet accepted your request". Adding in-app payment would need a buyer-side Paystack charge, verified by webhook, which moves `paymentStatus` to paid. That is not part of this change.

## Status machine and tracking

```
requested ──accept (vet)──▶ confirmed ──en_route (vet)──▶ en_route ──start (vet)──▶ in_progress ──complete (vet)──▶ completed
    │                          │   └──start (vet, from 1 h before)──────────────────▲
    ├─decline (vet)──▶ declined│
    ├─cancel (customer)──▶ cancelled ◀── cancel (vet: confirmed/en_route; customer: confirmed, until 2 h before)
    └─(no answer by respondBy)──▶ expired
```

- `PATCH /api/appointments/[id]` takes `{action, expectedStatus, reason?}`. The role comes from the session (customer or vet of this appointment). Anyone else gets 404.
- A transition applies only when the stored status equals `expectedStatus`, enforced by a conditional update. A stale or repeated action gets 409 and changes nothing.
- `completed`, `declined`, `cancelled` and `expired` are final.
- Each change appends `{status, by: customer|vet|system, at, note}` to `history`.
- Accepting re-checks that the vet is still verified.
- `respondBy` is 24 hours after booking, or the visit's start time if that comes sooner. After it passes, the request can't be accepted. It is expired when it's next read or acted on, and by the job.
- **Holds.** `declined`, `cancelled` and `expired` delete the appointment's slot holds in the same transaction as the status change, so the time is immediately bookable again. The job also releases any holds left on a finished appointment.
- **Tracking** means only the vet's own status updates. "On the way" is a button the vet presses. There is no live GPS, map or ETA, and the page says so.

## Notifications

A status change sets `notifySyncAt` in the same transaction (the outbox). The notifier then writes one notification per recipient per history entry. Each has `eventKey = appointment:<id>:<index>:<status>`, which is unique per recipient, so a retried or repeated sync never sends anything twice.

| Event | Recipient |
| --- | --- |
| Request | Vet |
| Accepted | Customer: "Booking confirmed" only when fully confirmed, otherwise "Vet accepted your request". |
| Declined | Customer |
| Cancelled | The other party |
| Expired | Both |
| On the way | Customer |
| Completed | Customer |

## Scheduled job

`POST /api/internal/appointments/process` takes `Authorization: Bearer <ORDER_JOB_SECRET>` from the same scheduler as the order job. It is unreachable (404) while the secret is unset and returns 401 for a wrong secret.

Each run:

1. Expires lapsed requests.
2. Releases leftover holds.
3. Refreshes the 50 stalest directory entries.

Each step is safe to repeat.

## Privacy and authorization

- **Directory cards and profiles** show only: id, name, photo, specialization, experience, state and area, service names, descriptions, prices and durations, hours, and next open time. They never show phone, email, registration number, qualifications, documents, credential status, notes or internal fields.
- **Phone numbers** appear only while an appointment is `confirmed`, `en_route` or `in_progress`. The vet sees the customer's phone. The customer sees the vet's phone only if the vet turned on **Share my phone number with customers**.
- **Appointment reads and lists** are scoped to the session user, as customer or vet. Any other id returns 404.
- **Authenticated responses** are never cached (`no-store`).
- **Availability** can only be read or changed by a veterinarian, and only their own.
- **Credentials** are still approved only in the existing admin review, which keeps its audit trail. Find a Vet adds no way around it.

## Tests

`tests/find-vet.test.ts` runs against the real route handlers and an in-memory replica set. The `Date` clock is fixed at Monday 4 Nov 2030, 08:00 Lagos; only `Date` is faked, so the driver keeps real timers. It covers:

- **Directory:** auth (401/403) and `no-store`; experience paging 12/12/6 across ties with no duplicates and the exact expected order; name sort with ties and `limit` up to 24; filters applied before paging (state, service and text across several pages); the date filter; unlisted entries excluded; cursor with other filters or sort, forged body, forged signature and junk all returning 400; bad `limit`, state, sort, date and service values; public fields only; a database failure returning a generic 500.
- **Listing:** listing only after admin approval (with an audit row); a missing credential status not counting as verified (for the profile, booking and the job rebuild); unlisting and a disabled service removing the vet; availability limited to vets and validated.
- **Profile:** inactive services hidden, no private fields, unknown or non-vet ids return 404.
- **Slots:** notice, opening hours, held times excluded, window validation.
- **Booking:** server price with client money, status and id fields ignored; the stored customer is the session user; 2 hold units; price snapshot; free means `not_required`; idempotent retry, key reuse with another time returning 409, and keys scoped per customer; three simultaneous bookings giving exactly one 201; overlapping longer visit; past, too-soon, out-of-hours, off-grid, blocked and out-of-window times; malformed times; own service, unknown service, another customer's farm, disabled service, bad location and bad key; unauthenticated, unverified and cross-origin requests.
- **Status:** party-only access and list scoping; the full path to `completed` with role checks, stale 409s and a final state; history actor and time; phone visibility rules; `isFullyConfirmed` for free and priced visits; re-check of verification on accept; decline and cancel releasing holds; the customer's 2-hour cancel cutoff; lapse on read and through the job; job auth; notifications sent exactly once after repeated syncs; transition validation.

The existing test suites still run unchanged.

## Manual checks (no browser test framework)

The repo has no browser test framework. Adding Playwright or Cypress would be a large new stack, so these checks are manual, on a phone-width window and with a screen reader where noted:

1. **Directory.**
   - Search, quick chips, filters, removing chips and **Clear all** all work.
   - **Load more** is disabled while loading.
   - Open a profile, press Back: the filters and list come back.
   - Turn the network off: the error state appears with **Try again**.
2. **Profile.**
   - The badge wording is correct and there is no phone or registration number.
   - **Book appointment** and **Book this service** open the wizard.
   - A vet viewing their own profile can't book.
3. **Wizard.**
   - The progress bar and percentage update at each step.
   - Days outside the window or the vet's weekdays are disabled.
   - Morning and Afternoon groups are shown.
   - Book a time in another tab, then press **Continue**: "no longer available".
   - **Change location** works, and the farm profile tiles match the farm.
   - The review's price matches the service.
   - Double-tap **Send request**: only one appointment is created.
4. **Confirmation.**
   - A priced request shows **Request sent** and the badge *Payment not collected in the app*.
   - A free service accepted by the vet shows *Booking confirmed* on the appointment page.
5. **Vet side.**
   - In `/availability`, the listing issues are shown and saving works.
   - In `/jobs`: accept, on the way, start, complete.
   - Decline with a reason, and the reason appears in the history.
   - Notifications arrive once.
6. **Accessibility.**
   - Keyboard: tab through chips, the calendar, the time radios and the dialogs-in-place, with visible focus everywhere.
   - Screen reader: step headings receive focus, and the live region announces result counts.
