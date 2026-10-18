# Training & Academy (Korret Academy)

Farmers browse published courses, watch lessons, and track their own progress. Admins write and publish the courses. A farm owner can invite staff by phone number and give each staff role a programme of courses. Every screen shows stored data only. The app has no invented courses, instructors, learner counts, ratings, staff or progress figures. There are no payments, paid certificates, paid media providers or external LMS.

## Screens (and where they depart from the design)

| Design screen | Route | Notes |
| --- | --- | --- |
| training-home "Korret Academy" | `/training` | **Search box:** matches title, topic (category) and instructor, with category and difficulty filters. Filters live in the URL, so back and forward keep them. **First unfiltered page:** shows the learner's open invitations, any programmes their farms assigned, **Continue learning**, and **Featured**. **Staff Training link:** shown only to owners with a farm profile. **Paging:** **More courses** and **First page** links. **Empty states:** separate ones for an empty catalogue, a search with no results, and the end of the list. |
| course-details "Course Overview" | `/training/courses/[id]` | **Shows:** the real fields: cover, category, difficulty, lessons, total length, description, objectives, prerequisites, and the ordered curriculum with ticks for completed lessons. **Button:** reads **Start**, **Continue**, **Resume** or **Review**. **Left out:** no rating, review count or learner count, because the app collects none. |
| video-lesson | `/training/courses/[id]/lessons/[lessonId]` | **Player:** a native `<video>` element; no iframes and no embedded HTML. **Resume:** starts from the saved position. **Lesson details:** summary and PDF resources. **Navigation:** previous and next lesson links, an **All lessons** list, and an explicit **Mark as complete** button. **Missing video:** shows an "unavailable" notice instead of a broken player. |
| staff-training "Staff Training Programs" | `/training/staff` | **Who:** owners only. **Programmes:** one per role (Farm Attendants, Farm Managers, Egg Sorters/Handlers, Hatchery Operators), each a list of published courses. **People:** invite by phone, change role, remove or withdraw. **Progress:** shown for each accepted member. **No farm:** the page links to farm setup instead. |
| — | `/admin/training`, `/admin/training/new`, `/admin/training/[id]`, `/admin/training/[id]/preview` | The admin course list, the course editor, and the learner-view preview, which also works for drafts. Linked from the Admin console. |

The bottom nav's **Training** tab now goes to `/training`. Nothing else in the app was restyled.

## Data model

| Collection | What it holds |
| --- | --- |
| `courses` | **Status:** `status` is `draft` or `published`. **Details:** title, description, instructor, category, difficulty, objectives, prerequisites, `coverUrl`, `featured`. **Curriculum:** ordered `modules[]`, each with ordered `lessons[]` (title, summary, `durationSeconds`, `videoUrl`, ordered `resources[]`). **Derived on every save:** `lessonCount`, `durationSeconds` and `searchWords`. **Also:** `publishedAt`, `createdBy`, `createdAt`, `updatedAt`. |
| `course_enrollments` | One per learner and course: `userId`, `courseId`, `enrolledAt`, `lastLessonId`, `lastActivityAt`, and `completedAt` (the first time the whole curriculum was complete). |
| `lesson_progress` | One per learner, course and lesson: `positionSeconds`, `completedAt` (null until completed), `createdAt`, `updatedAt`. |
| `farm_staff` | One per invitation: `farmId`, `ownerUserId`, `phoneNormalized`, `role`, `status` (`invited`, `active`, `declined`, `removed`), `open`, `userId` (set on acceptance), `invitedAt`, `respondedAt`, `removedAt`. Records are closed, never deleted. |
| `training_programs` | One per farm and role: the ordered `courseIds`, plus `updatedBy` and `updatedAt`. |
| `admin_audit` (existing) | Gains `course.create`, `course.update`, `course.publish` and `course.unpublish`, written in the same transaction as the change. |

**IDs and order:**
- Module, lesson and resource IDs are 16 hex characters, issued by the server when an item is first saved.
- The editor sends the IDs back with every save. The server accepts only IDs that already belong to that course and that kind of item, and only once each. An unknown, foreign or duplicated ID is refused with a field error; it is never adopted. So a lesson keeps its ID, and its learners' records, when it is edited, renamed or moved.
- Order is the array order. There is no separate position number to drift out of sync.

**Compatibility:** all collections are new. No existing document or field changes shape.

## Publishing

1. Saving the course form creates or updates a **draft**, whatever `status` or `publishedAt` the request body claims.
2. Drafts are private:
   - Every learner query filters on `status: "published"`. A draft, an unpublished course, an unknown ID and a malformed ID all return the same 404, whether you ask for the course, a lesson, enrolment, position or completion.
   - Admins can see a draft in the editor and in **Preview**. Preview records nothing.
3. **Publish** is refused, with the reasons, until the course has at least one lesson, no empty modules, and a valid video on every lesson. The editor shows the same reasons and disables the button.
4. A published course can be edited in place, but every save must leave it publishable. To make bigger changes, unpublish it, edit the draft, then publish again.
5. **Unpublish** returns the course to draft. Learners' enrolments and progress records are kept and count again if the course is republished.
   - Republishing sets a new `publishedAt`, so the course moves to the top of the catalogue.
6. **Conflicts:** every update and status change carries the `updatedAt` it was based on. A stale one gets a 409 ("changed since you opened it") instead of overwriting someone else's edit.
7. **Who can:** only the admin allowlist (`ADMIN_USER_IDS`) can do any of this, through `requireAdminRequest`. Everyone else gets the same 404 as a missing page. Hiding the admin links is not the protection; the API checks every call.

**Featured:** a course appears under **Featured** when an admin ticks `featured` and the course is published. Up to 6 show, newest publication first. There is no automatic or popularity-based ranking.

## The catalogue and pagination

`GET /api/training/courses?q=&category=&difficulty=&limit=&cursor=` (the page uses the same functions server-side).

- **Search:** `q` is cleaned to at most 5 words and 60 characters. Each word must be a prefix of a word in the course's title, category label or instructor (case- and accent-insensitive), using the `searchWords` index.
- **Filters:** `category` and `difficulty` must be known values. An unknown value is a 400 with a field error from the API. The page ignores and drops unknown values instead.
- **Order:** newest publication first, then `_id`, using a keyset cursor. There are no offsets and no total counts.
- **Cursors:**
  - A cursor is HMAC-signed together with the search's filters. It continues only the search it came from.
  - A cursor from another search, or a tampered or garbage cursor, is a 400 ("This list has changed. Start the search again."). The page then sends you back to the first page.
  - `limit` is 1–24 (default 10) and is not part of the signed search.
- **Limits:** reads are rate-limited per user (`trainingReadsPerUser`).

## Progress

- **Learner:** always the session's user. A user ID, percentage or completion flag in a request body is ignored.
- **Enrol:** `POST /api/training/courses/[id]/enroll` is idempotent. An upsert on the unique `(userId, courseId)` index retries once on a duplicate-key race.
- **Position:** `PUT …/lessons/[lessonId]/position` with `{ positionSeconds }`, a number from 0 to 12 hours, rounded down.
  - The player saves at most every 15 s and only after at least 3 s of movement. It also saves on pause, on end, and with `keepalive` when the page is hidden or closed.
  - A position never marks a lesson complete.
- **Complete:** `POST …/lessons/[lessonId]/complete` is explicit and idempotent.
  - The lesson must exist in the **published** course's current curriculum.
  - The first completion time is kept; repeats change nothing. There is exactly one record per learner, course and lesson, enforced by a unique index.
  - When every lesson is complete, the enrolment's `completedAt` is set once.
- **Percentages are calculated, never stored:**
  - Progress is completed lessons of the *current* curriculum over its lesson count, rounded down.
  - A completion for a lesson that was later removed is kept but doesn't count. A newly added lesson lowers the percentage until it is done.
  - Staff summaries also never show more completed lessons than the course now has.
- **Continue learning:** unfinished courses with at least one lesson, taken from the learner's 10 most recent enrolments, up to 3.
- **Resume:** goes to the last lesson worked on if it is unfinished, otherwise the first unfinished lesson.
- **Limits:** progress writes are rate-limited per user (`trainingProgressWritesPerUser`), and mutations require the app's own `Origin`.

## Media

Course media is **referenced, not uploaded through the app**. No video or PDF passes through Next.js, and no new provider was added.

1. In the team's existing Cloudinary account (the one used for profile and product photos), upload the video, cover image or PDF.
2. Copy its plain delivery URL and paste it into the course editor.

The server accepts a URL only when all of these hold:
- It is `https://res.cloudinary.com/<the configured cloud name>/…/upload/…`.
- The resource type is right: `video` for lessons; `image` for covers; `image` or `raw` for PDFs.
- The extension is allowed: `mp4`/`webm`; `jpg`/`jpeg`/`png`/`webp`; `pdf`.
- It has no query string, fragment, credentials, port, encoded characters or dot segments, and the text is already in its normalised form.

**Checked again on display:** the same check runs every time media is shown. A URL that no longer passes, for example after the cloud name changes or a bad value was written directly to the database, is treated as missing:
- The cover becomes a placeholder.
- The lesson shows "video unavailable".
- The PDF is left out.

**When Cloudinary isn't configured:** the editor says so, and media fields can't be filled.

**Rendering:** videos play in a native `<video>`. PDFs open in a new tab with `rel="noopener noreferrer"`. No iframes and no admin-supplied HTML are rendered.

## Staff training rules

- **Owners:** only the signed-in owner of a farm profile can manage that farm's staff and programmes. The farm is looked up from the session; a `farmId` in the body is ignored. Without a farm, every staff call is a 403.
- **Invite:** by Nigerian mobile number and role.
  - The owner's own number, an invalid number, an unknown role, or a number already invited or on staff is refused.
  - A farm can have at most 50 open invitations and members.
- **Accept:**
  - The invitee must be signed in to a **verified** account whose phone number is the invited number.
  - Anyone else, including the owner, gets a 404 for that invitation.
  - Declining closes the invitation, and the owner may invite the number again.
- **Visibility:**
  - Before acceptance the owner sees only the masked number and role: no name and no progress, even if the person is already taking the courses.
  - After acceptance the owner sees the member's name and, for each course in their role's programme, completed and total lessons of the current curriculum. These are counted from the member's own records with one grouped query.
- **Changes:** change role, or remove or withdraw. Another owner's member IDs are a 404. Removing someone ends their assignment but keeps their own learning records, which belong to them.
- **Programmes:**
  - Up to 12 **published** courses per role. Drafts, unknown IDs, duplicates and unknown roles are refused.
  - A course that is later unpublished silently drops out of the programme until it is republished.
  - The picker offers the 100 most recently published courses.
- **Roles are training categories, not permissions.** Membership grants no access to the owner's farm data, orders or wallet.

## Indexes

Created by `npm run db:setup` (`lib/server/indexes.ts`):

| Collection | Index | Purpose |
| --- | --- | --- |
| `courses` | `status_published` `{status, publishedAt:-1, _id:-1}` | catalogue order and cursor |
| `courses` | `status_category_published` | category filter |
| `courses` | `status_featured` | Featured |
| `courses` | `search_words` | word-prefix search |
| `courses` | `recently_updated` | admin list |
| `course_enrollments` | `learner_course_unique` (unique) | one enrolment per learner and course |
| `course_enrollments` | `learner_recent` | Continue learning |
| `lesson_progress` | `learner_lesson_unique` (unique) | one record per learner and lesson; every progress read |
| `farm_staff` | `farm_phone_open` (unique, partial on `open: true`) | one open invitation or membership per farm and number |
| `farm_staff` | `farm_status`, `phone_status`, `member_status` | staff list, invitations, memberships |
| `training_programs` | `farm_role_unique` (unique) | one programme per farm and role |

Every list query has a `limit`.

## Setup

1. Run `npm run db:setup` once against each database to create the indexes.
2. Make sure the Cloudinary configuration already used for photos is set. Only the cloud name is needed to validate references; nothing is uploaded by the app.
3. Add admin user IDs to `ADMIN_USER_IDS` (comma-separated). Admins create courses at **Admin → Training courses**.

No new environment variables are needed.

## Limitations

- **No certificates.** Paid certificates are out of scope and free ones were not built. Completion is recorded (`course_enrollments.completedAt`) and could back a certificate later.
- **Completion is self-reported.** **Mark as complete** is explicit and validated against the published curriculum, but the app does not check how much of a video was watched. Positions are saved for resuming only.
- **No uploads from the app.** Admins upload media in Cloudinary and paste the URL. Media is public delivery URLs on Cloudinary; there are no signed or expiring URLs.
- **Republishing moves a course to the top** of the catalogue (a new `publishedAt`).
- **The programme picker offers the 100 newest published courses**, and a learner's Continue learning looks at their 10 most recent enrolments.
- **No ratings, reviews, learner counts or comments.**
- **Search is word-prefix matching**, not full-text relevance.

## Tests

`tests/training.test.ts` runs the real route handlers against an in-memory replica set:
- **Catalogue:** access, published-only, search and filters, cursor paging, refusal of bad filters, sizes and cursors (including another search's cursor and a tampered one), the empty catalogue, unavailable media, and Featured.
- **Progress:** idempotent and concurrent enrolment and completion, positions scoped to the learner, forged body fields, progress after curriculum edits, and unpublish then republish.
- **Admin:** non-admins and signed-out callers refused, drafts forced, media and field validation, foreign or duplicated IDs, stale versions, publish rules, and the audit trail.
- **Staff:** a farm is required; invitations, acceptance by the invited number only, no progress before acceptance, summaries matching the records, forged roles and courses, cross-farm isolation, and removal.
