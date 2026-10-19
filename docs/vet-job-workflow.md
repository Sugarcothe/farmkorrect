# Veterinary jobs and appointment progress

The vet's side of a Find a Vet appointment: the **My Jobs** tabs, the **job offer**, the **visit in progress** (timer, checklist, private clinical notes) and **completing** the visit. All of it sits on top of the existing appointments collection and status machine ([find-vet.md](find-vet.md)). There is no second jobs system.

## Screens

| Screen | Route | Notes |
| --- | --- | --- |
| My Jobs | `/jobs?tab=pending\|active\|completed\|closed` | Without `tab`, it opens on Pending if anything is waiting, otherwise on Active. Pending and Active show counts, capped at "99+". |
| Job offer | `/appointments/[id]` (vet, `requested`) | Shows the customer, farm and flock, the service and its length, the date and time, the address and directions, the reference and the real `respondBy` time. Accept asks for confirmation. Decline opens a form with an optional reason. |
| Appointment progress | `/appointments/[id]` (vet, `in_progress`) | Shows the elapsed timer, the visit checklist, the clinical notes and a "Complete visit" button. |
| Completed visit | `/appointments/[id]` (vet, `completed`) | Shows the visit length and a read-only checklist and notes. |

- The list cards link to `/appointments/[id]?from=<tab>`, so the back link returns to the same tab. `from` is validated and only chooses the back link.
- **Tabs.**
  - Pending: `requested`.
  - Active: `confirmed`, `en_route`, `in_progress`.
  - Completed: `completed` only.
  - Closed: `declined`, `cancelled`, `expired`. These are never shown or counted as completed.
- **Cards** show the reference, customer, farm name, service, date and time, status, and the flock.
  - The flock comes from the type and bird count on the customer's farm record. It is read live, and only while that farm still belongs to the customer.
  - A booking typed in without a farm shows "Flock details not linked" instead.
- **Left out on purpose.** The mockups show a distance, a map, an ETA, a countdown and a fee or payout. None of these appear: the app has no location data, and payment isn't collected in the app. The existing Price section stays as Find a Vet defined it.

## Lists (server-side)

- `GET /api/appointments?as=vet&tab=<tab>[&cursor=]` (the page calls `listAppointments(user, "vet", cursor, now, tab)` directly).
  - It is always scoped to the session's vet (`vetUserId`). A `tab` with `as=customer` is a 400.
- **Paging.**
  - Keyset paging on `(startsAt, _id)`, 20 per page.
  - Pending and Active list the soonest first. Completed and Closed list the newest first.
  - The cursor includes the view and the tab (`vet.active.<ms>.<id>`). A cursor from one tab or view is a 400 on another, and the page then starts again.
  - Cursors without a tab are unchanged.
- **Index.** The existing `vet_status_starts` index `{vetUserId, bookingStatus, startsAt}` serves the tab filter and order, so no index was added. `npm run db:setup` is still the way to create indexes on a new database.

## Visit record (data)

Fields added to `appointments`. All are optional, so older documents still read correctly.

| Field | Meaning |
| --- | --- |
| `startedAt` | Set in the same update as the move to `in_progress`, equal to that history entry's `at`. Older visits fall back to the last `in_progress` history entry. |
| `completedAt` | Set in the same update as the move to `completed`. |
| `visit.template` | `{category, version}`. The checklist template is versioned (`VISIT_TEMPLATE_VERSION` in `lib/vets/visit.ts`). |
| `visit.checklist[]` | `{id, label, required, doneAt, doneBy}`. This is a snapshot taken when the visit starts. Later template changes never alter a visit already under way. |
| `visit.vaccineDetails` | True for vaccination visits, which adds the vaccine product, batch/lot and administration fields to the notes. |
| `visit.notes` | Observations, findings, procedure details, follow-up recommendations, plus the vaccine fields. |
| `visit.notesVersion`, `notesUpdatedAt`, `notesUpdatedBy` | Concurrency control and audit for the notes. |

- **Template.** Every service category gets these items:
  - Arrived at the farm *(required)*.
  - Pre-service assessment *(required)*.
  - The agreed service step, worded per category *(required)*.
  - Visit records completed *(required)*.
  - Follow-up discussed *(optional)*.
- **What the checklist means.** It records what the vet says was done. It suggests no treatment, dose or diagnosis, and a ticked item doesn't mean an intervention was clinically right.
- **Older visits.** A visit that was already in progress when this shipped has no `visit`. The vet sees one built from the current template, marked `stored: false`. It is saved on the first checklist change, note save or completion attempt.

## API

The visit record is only for the appointment's own vet. The customer, other vets and unknown or malformed ids all get the same 404. Signed-out requests get 401. Mutations are same-origin only (403 otherwise) and rate limited by `appointmentVisitWritesPerUser`, 600 per hour.

| Method | Route | Body | Behaviour |
| --- | --- | --- | --- |
| GET | `/api/appointments/[id]/visit` | – | The vet's record. 404 before the visit starts. |
| POST | `/api/appointments/[id]/visit/checklist` | `{itemId, done}` | Sets one item's state. A repeat changes nothing. An item not on this visit's snapshot is a 400. Any status other than `in_progress` is a 409. |
| PUT | `/api/appointments/[id]/visit/notes` | `{notes: {...partial}, expectedVersion}` | See the rules below. Body limit is 48 KB. |

**Note save rules**

- The update is conditional on `notesVersion === expectedVersion`.
- A stale version is a 409 with `fieldErrors.expectedVersion`, unless the stored notes already equal the submitted ones (a retried save). In that case it returns 200 and changes nothing.
- Text is normalised with `cleanText`.
- Length limits:
  - observations, findings and procedure: 2000 characters each;
  - follow-up: 1000;
  - vaccine product: 120; batch: 60; administration: 300.
- Unknown fields are a 400, and so are vaccine fields on a visit that isn't a vaccination.

**Appointment responses** add `farm`, `startedAt` and `completedAt`, plus `visit`, which is the vet's record and is always `null` for the customer. List summaries add `farmName` and `farm`.

## Completing

- `PATCH /api/appointments/[id]` with `{action: "complete", expectedStatus: "in_progress"}`, as before.
- The server checks the stored record:
  - every required checklist item done;
  - observations saved.
- If anything is missing, the response is a 409, nothing changes, and `fieldErrors.missing` lists what's missing.
- **Atomic.** The same conditions are part of the completion update's filter. The status, `completedAt`, the history entry (actor and time) and the outbox marker are all written in one conditional update inside the existing transaction.
- **Nothing the browser sends counts.** A `bookingStatus`, `visit` or timestamp in the body is ignored.
- **Final.** A repeated complete is a 409, so there are no duplicate history entries or notifications. Once completed, the checklist and notes reject changes (409) and the status can't be reopened.
- **No financial changes.** Completion doesn't touch `paymentStatus` (a priced visit stays `payment_required`), the ledger, wallets or payouts. No fee, commission or payout is shown on the job screens.

## Timer

- The elapsed time is `now − startedAt`. It is computed in the browser and corrected by the server's clock at render, so it carries on correctly after a reload. Nothing is written while it runs.
- If the start can't be established, it shows "Elapsed time unavailable" instead of a number.
- The planned length is shown only when the service has a duration.
- **Accessibility.** The ticking digits are `aria-hidden`. Screen readers get the start time once, as text, and nothing is announced every second.

## Notifications

- These go through the existing outbox (`notifySyncAt`) and event keys, so each one is sent once.
- Accept, decline, completion and the rest are unchanged.
- **New: "Visit started"** (`appointment_started`, push), sent to the customer when the vet starts the visit.
- No notification ever includes the checklist or notes. Note text is never logged or put in a URL.

## Tests

`tests/vet-job-workflow.test.ts` covers:

- the job tabs: server filtering, vet scoping, farm data, tab-bound cursors and ordering;
- card rendering, with no distance or ETA;
- the job offer fields, a stale accept after a decline, and ignored client overrides;
- the start snapshot and its notification;
- the timer: formatting, no live announcements, and the "unavailable" state;
- the checklist: actor and time, idempotence, unknown items, 401/403/404 for the customer, other vets, foreign ids and other origins;
- notes: versioning, conflicts, retries, normalisation, limits and vaccine fields;
- privacy: notes never reach the customer, notifications or logs;
- completion: requirements, atomic final state, idempotence, no ledger or payment change;
- older visits without a record.

**Change to an existing test.** The full-path test in `tests/find-vet.test.ts` now ticks the required items and saves observations before completing, and also checks that completing earlier is refused. That is a new requirement, not a weakened test.

## Manual checks (no browser test framework)

1. As a vet with a pending request, open `/jobs`.
   - It opens on Pending with a count.
   - Cards show the flock ("Broiler · 5,000 birds").
   - Switch tabs. Open a job and press Back: you return to the same tab.
2. Open the offer. Check the respond-by time, address and directions.
   - Accept: a confirmation step appears. Confirm, and the status becomes Confirmed.
   - In a second tab, try Accept on the old screen: you get an error and the page refreshes to the real state.
3. Decline another request with a reason. It moves to Closed, not Completed.
4. Press "I'm on my way", then "Start visit".
   - The timer runs. Reload: it continues from the real start.
   - With a screen reader, the timer isn't read out every second.
5. Tick and untick items with the keyboard (Tab, Space). The change is announced, and "done 10:42" appears.
6. Type notes. "Unsaved changes" shows. Save, and you see "Saved …".
   - Edit the same notes in a second tab and save there, then save the first tab: a conflict message and "Reload the latest notes" appear.
7. "Complete visit" stays disabled while anything is missing, and the list says what is missing.
   - Finish the list, confirm, and the visit becomes read-only.
   - As the customer, the appointment shows Completed with no checklist or notes, and there was a "Visit started" notification.
8. At phone width (360 px): the tabs scroll sideways, nothing scrolls the page horizontally, and the focus rings are visible.
