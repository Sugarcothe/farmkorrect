# Analytics & reporting

Read-only reports for sellers (`/market/insights`) and admins
(`/admin/analytics`). Every figure is aggregated on the server from the
existing collections. Nothing here writes to the ledger, orders, payments,
refunds, payouts or promotions. The only writes are the rate-limit counters
every API already uses.

Code:

| What | Where |
| --- | --- |
| Metric services | `lib/server/analytics.ts` |
| Date ranges | `lib/analytics/range.ts` (shared by server and browser) |
| CSV | `lib/server/csv.ts` |
| Response shapes | `lib/analytics/types.ts` |
| APIs | `app/api/analytics/seller` (`/export`), `app/api/admin/analytics` (`/export`) |

## Principles

- **Integer kobo everywhere.** All amounts are sums of integer kobo fields;
  the services never divide money. Percentages are only computed for
  display, and are `null` (never `NaN` or `Infinity`) when the denominator is
  0.
- **A sale is money a payment confirmed.** An order counts as paid only when
  `orders.paidAt` is set. That happens once, in the conditional update that
  marks the order paid after Paystack verification. Payment attempts
  (`payments`) are never summed. A retried, failed, superseded or closed
  attempt therefore can't add a sale, and an order that was paid after two
  failed attempts counts once.
- **Four concepts are kept apart:** money collected, discounts, refunds and
  ledger earnings. They are never added to one another, except where a
  formula below says so.
- **The ledger is the source of truth for earnings, fees and balances.**
  Commission is never computed here. Fees are the `platform_fee` entries the
  order module recorded under the configured policy. With no policy
  configured there are no earnings in the ledger, and the report says so
  rather than estimating any.
- **Balances only from `getWalletSummary`.** The seller's current balances
  come from the same function the Wallet uses, never from a separate
  calculation.
- **Period activity vs. current state.** A period figure counts events whose
  timestamp falls inside the period. A "now" figure is the current state,
  whatever the period. The UI labels the two separately, and the
  period-over-period comparison only covers period figures.

## Dates and timezone

- **Lagos time.** Days are Africa/Lagos days. Lagos is WAT, UTC+01:00 all
  year, with no daylight saving. Day boundaries are computed explicitly as
  `Date.UTC(y, m, d) − 1 h`, and "today" comes from
  `Intl.DateTimeFormat(…, { timeZone: "Africa/Lagos" })`. The server's own
  timezone is never used. MongoDB buckets by day with
  `$dateToString { timezone: "Africa/Lagos" }`.
- **Half-open ranges.** Every range is `[start, end)`: a timestamp of exactly
  `end` belongs to the next period.
- **Presets:**

  | Preset | Range | Compared with |
  | --- | --- | --- |
  | `last7` | today and the 6 days before | the 7 days before |
  | `last30` | today and the 29 days before | the 30 days before |
  | `this_month` | the 1st of this month until the end of today | the same number of days from the 1st of last month, clamped to last month's end |
  | `last_month` | the whole previous calendar month | the month before it |
  | `custom` | `from`–`to` (inclusive Lagos dates, `YYYY-MM-DD`) | the same number of days immediately before |
- **Validation.** A custom range is refused with a 400 and a field error when:
  - a date is not a real calendar date;
  - `from` is after `to`;
  - `to` is after today in Lagos;
  - `from` is before 2024-01-01;
  - the range is longer than **366 days**.

  An unknown `period` is refused the same way.
- **Granularity.** The trend is daily for ranges up to 62 days and weekly
  beyond that. Weeks start on the range's first day and the last one may be
  partial.
- **When a comparison is shown.** A comparison is shown only when there is
  history: the seller (or, for admins, the marketplace) has an order created
  before the period starts. Otherwise `previous` is `null` and the UI says
  there is no earlier period to compare with. A change is the integer
  difference, plus a percentage only when the previous value is above 0.

## Seller metrics

The seller is always `session.user._id`, never a request parameter. Every
query has `sellerUserId` (orders, products, promotions, redemptions) or
`userId` (ledger, payouts) as part of the query itself.

### Sales overview (period)

| Metric | Definition |
| --- | --- |
| Orders placed | orders with `createdAt` in the period, paid or not (an order placed is not a sale) |
| Paid orders | orders with `paidAt` in the period |
| Completed orders | orders with `deliveredAt` in the period (the seller marked them delivered) |
| Cancelled orders | orders with `cancelledAt` in the period, split into "before payment" (`paidAt` null; includes unpaid orders that expired) and "after payment" (refunded through the order's refund) |
| Refunded orders | distinct orders with an `order`-kind refund whose `status` is `processed` and whose `processedAt` is in the period |
| Awaiting payment (now) | current state: orders with `paymentStatus` pending or failed and `fulfillmentStatus` pending. Not a period figure |
| Sales collected | **flow.** Σ `paidKobo` of the paid orders. What Paystack confirmed the buyer paid, discount already taken off |
| Discounts given | **flow.** Σ `promotion.discountKobo` (the order-time snapshot) of the same paid orders. Orders without a promotion, including orders from before promotions existed, add 0. Seller-funded: it was never collected, so it's not a cost subtracted from sales |
| Refunds | **flow.** Σ `amountKobo` of the processed `order` refunds above, as the buyer received them. A refund can belong to a sale from an earlier period; it is counted in the period it was processed and is never subtracted from that earlier period |
| Sales after refunds | sales collected − refunds, for the period. Can be negative when refunds of earlier sales exceed the period's sales |
| Trend | per day or week: paid orders and sales collected (by `paidAt`), refunds (by `processedAt`) |

Excluded:
- unpaid, failed, cancelled-before-payment and expired orders never reach
  sales;
- refunds that are `creating`, `pending` or `failed`;
- `late_payment` refunds. They return money that arrived after its order
  was closed, which was never a sale.

**Avoiding duplicates:**
- `paidAt` is set once per order;
- refunds are separate documents with unique references;
- the trend and the CSV use the same filters as the cards, so their totals
  add up to the card figures.

### Product performance (period)

The source is the paid orders of the period, unwound by `items`, grouped by
`productId`:

- **Units:** Σ `quantity`.
- **Orders:** the number of distinct orders containing the product.
- **Sales:** Σ (`lineTotalKobo` − `discountKobo`). That is the line's price
  less its share of the discount, from the order-time snapshot.

| Topic | Behaviour |
| --- | --- |
| Names | the product's current name when it still exists, otherwise the name stored on the order |
| Rankings | best sellers by units and by sales, top 10 each, chosen from at most 1,000 products ranked by sales (a seller with more products sold in one period would see `X-Truncated: true` on the CSV); the CSV has every row up to that limit |
| No sales | the seller's listings that aren't archived, have no paid order in the period, and were created before the period ended (at most 50 shown, plus the total count) |
| Insufficient history | shown when the period has fewer than 3 paid orders: rankings from so few orders aren't meaningful |
| Refunds | refunds are per order, not per line, so product sales are **before refunds**. This is labelled on screen and in the CSV |
| Amount mismatch | if Paystack confirmed an amount other than the order total (an order flagged for review), product sales follow the priced lines, while sales collected follows `paidKobo` |

### Earnings (ledger)

Period flows come from `ledger_entries` with `userId` = the seller and
`createdAt` in the period, grouped by `type`. Each entry is unique by
`idempotencyKey`, so a sum can't count an event twice.

| Metric | Entry type |
| --- | --- |
| Earnings recorded (gross) | `earning` (the paid amount at settlement) |
| Platform fees | `platform_fee`, as recorded; never recomputed |
| Refunds taken from earnings | `refund`: the seller's share of a refund (refund − the fee's proportional share) |
| Net earnings | earning − platform fee − refund entries |
| Payouts paid | `payout_paid` |

Adjustments: the ledger has no adjustment entry type. A `payout_release`
returns a failed payout's hold to the balance. It is shown as "returned from
failed payouts", not as earnings.

| Topic | Behaviour |
| --- | --- |
| Paid orders not yet in the ledger (now) | the seller's orders that are paid, not cancelled and have `settlement: null`, typically because no commission policy is configured. The count is shown so the gap between sales and earnings is visible; no amount is guessed |
| Balances (now) | `getWalletSummary(sellerId)`: available, pending, under review (on hold for an open issue or an in-flight refund), held for payouts, paid out and owed. Exactly what the Wallet shows |
| Payouts | requested in the period: count and amount by **current** status (requested, processing, paid, failed). Paid in the period: by `paidAt`. Failed in the period: by `failedAt`. Statuses are never added together |
| Seller-funded discounts | the "discounts given" figure above, repeated for context. Earnings are computed from what buyers paid, so a discount is already reflected in them and is not subtracted again |

### Promotions (period)

| Metric | Source |
| --- | --- |
| Paid orders, discount granted, sales collected | the seller's paid orders in the period (by `paidAt`) carrying `promotion`, grouped by `promotion.promotionId`. Built from the order-time snapshot, so editing or ending a promotion later doesn't change them |
| Redeemed uses | redemptions with `status` redeemed and `redeemedAt` in the period |
| Reserved uses (now) | redemptions currently `reserved`: an unpaid order holding a use. They are not completed uses and are never counted as such |
| Name, status | the current `promotions` document (so a renamed promotion shows its new name), falling back to the snapshot name if it no longer exists. Only the label follows the promotion; every amount stays as the order was priced |

Notes:
- **Released uses** (cancelled, expired or refunded-on-cancellation orders)
  count nowhere.
- **Paid orders vs redeemed uses.** A paid order that is later cancelled and
  refunded keeps its place under "paid orders" for the period it was paid,
  but its use is released.
- **No profit claims.** Discount and sales are shown side by side. No ROI,
  uplift or profit is computed.

## Admin metrics

Every admin endpoint calls `requireAdminRequest`, and every page calls
`requireAdminPage`. Both check the `ADMIN_USER_IDS` allowlist against a
live, fully authenticated session. Anyone else gets a 404 and anonymous
users a 401, as elsewhere in /admin. Admin reports name no buyers or
sellers, and contain no phones, emails, bank details, recipient codes or
provider references.

### Marketplace activity

| Metric | Definition |
| --- | --- |
| Registered accounts (now) | users by `role`, and by `status` (phone verified = `active`). These are **registered accounts**, never "active users": nothing records usage |
| New registrations | users with `createdAt` in the period, by role. Pending accounts that are never verified are deleted by a TTL index, so this undercounts unverified sign-ups |
| Orders | placed, paid, completed and cancelled in the period (same definitions as the seller's, over all sellers), plus current counts by `paymentStatus` and by `fulfillmentStatus` |
| Listings (now) | not archived and live (`active` true), not archived but hidden, archived; plus new listings created in the period |
| Seller activity | distinct sellers with at least one paid order in the period; distinct sellers with a live listing now |
| Promotion adoption | promotions by current status; distinct sellers with an active promotion now; paid orders in the period that used a promotion, and the discount they carried |

### Financial (period unless marked)

| Metric | Definition |
| --- | --- |
| Paid amounts | Σ `paidKobo` of orders with `paidAt` in the period |
| Refunds to buyers | Σ processed `order` refunds by `processedAt` |
| Net captured | paid amounts − refunds to buyers. A **flow** for the period, not a balance: refunds of earlier payments reduce it |
| Late payments returned | processed `late_payment` refunds (money for closed orders, returned in full). Kept out of both paid amounts and refunds |
| Refunds in progress (now) | `creating` or `pending` refunds; count and amount |
| Refunds failed | `failed` refunds with `failedAt` in the period |
| Platform fees recorded | Σ `platform_fee` entries created in the period. This is the commission the ledger recorded at the configured rate. It is the only commission figure: none is estimated |
| Fees returned on refunds | for `refund` entries created in the period: Σ (buyer refund `amountKobo` − the entry's seller share), joined on `refundId` = `refunds.reference` |
| Seller earnings | Σ `earning` − Σ `platform_fee` − Σ `refund` entries created in the period |
| Payouts | paid (by `paidAt`), failed (by `failedAt`) and requested (by `requestedAt`) in the period, each a separate figure; in progress now (requested + processing) |

Duplicates:
- each source document is counted once, by its own timestamp;
- ledger entries are unique by `idempotencyKey`;
- payout amounts come from `payouts`, not from the `payout_hold` /
  `payout_paid` pair, so a payout is never counted twice.

### Operational (now)

These reuse the exact filters behind the admin dashboard and exceptions in
`lib/server/admin-queues.ts`:

- open order issues;
- flagged orders (`reviewIssue`);
- flagged payouts (`issue`);
- failed notification deliveries (`failed` or `exhausted`).

There are three additions:
- orders whose ledger sync is pending (`ledgerSyncAt` set);
- payouts that failed in the period;
- paid orders not yet in the ledger.

Each card links to the existing queue.

## CSV exports

| Export | Endpoint | Columns, in this order |
| --- | --- | --- |
| Seller trend | `GET /api/analytics/seller/export?report=trend` | `date_from, date_to, orders_placed, paid_orders, sales_collected_kobo, refunds_kobo` |
| Seller products | `?report=products` | `product_id, product_name, units, orders, sales_before_refunds_kobo` |
| Seller promotions | `?report=promotions` | `promotion_id, promotion_name, status, code, paid_orders, redeemed_uses, reserved_uses_now, discount_kobo, sales_collected_kobo` |
| Admin trend | `GET /api/admin/analytics/export?report=trend` | `date_from, date_to, orders_placed, paid_orders, paid_kobo, refunds_kobo, new_accounts` |

Trend rows are the chart's buckets: one row per Lagos day for ranges up to
62 days (`date_from` = `date_to`), otherwise one per 7-day run from the
first day of the range (the last may be shorter).

All exports:
- **Range and auth.** Take the same `period`/`from`/`to` and the same
  authorization as the screen, and call the same service functions, so CSV
  totals equal the on-screen figures.
- **Units.** Amounts are integer kobo (₦1 = 100 kobo); dates are Lagos dates.
- **Row limits.** At most **1,000** rows. A trend has at most 62 daily or
  53 weekly rows, so only products or promotions could hit it. When rows were cut,
  the response carries `X-Row-Limit: 1000` and `X-Truncated: true`, and the
  screen says so next to the download.
- **Formula injection.** A text cell starting with `=`, `+`, `-`, `@`, tab
  or carriage return is prefixed with `'`. Every text cell is quoted, with
  `"` doubled.
- **Headers.** Responses are sent with `Cache-Control: no-store` and
  `Content-Disposition: attachment`.
- **No PII.** No buyer or seller names, phones, emails, bank details,
  recipient codes or Paystack references. Product and promotion names are
  the seller's own content.
- **Rate limits.** Exports are limited by `analyticsExportsPerUser`
  (30 per hour, sellers and admins). Seller report reads are limited by
  `analyticsReadsPerUser` (300 per 15 min); admin report reads share the
  existing `adminReadsPerUser` limit with the rest of /admin.

## Indexes

Added in `lib/server/indexes.ts` and created with `npm run db:setup`. The
app never creates indexes itself.

| Collection | Index | Serves |
| --- | --- | --- |
| orders | `seller_paid` `{sellerUserId, paidAt}` | seller sales, products, promotions |
| orders | `seller_delivered` `{sellerUserId, deliveredAt}`, `seller_cancelled` `{sellerUserId, cancelledAt}` | seller completed and cancelled counts |
| orders | `paid` `{paidAt}`, `created` `{createdAt}`, `delivered` `{deliveredAt}`, `cancelled` `{cancelledAt}` | admin order figures |
| refunds | `status_processed` `{status, kind, processedAt}`, `status_failed` `{status, failedAt}` | refunds processed or failed in a period |
| ledger_entries | `user_created` `{userId, createdAt}`, `created_type` `{createdAt, type}` | seller and admin ledger flows |
| payouts | `user_requested` `{userId, requestedAt}`, `requested` `{requestedAt}`, `paid` `{paidAt}`, `failed` `{failedAt}` | payouts by event date |
| users | `created` `{createdAt}` | registrations |
| products | `created` `{createdAt}` | new listings |
| promotion_redemptions | `seller_status` `{sellerUserId, status, redeemedAt}` | redeemed and reserved uses |

None of these are partial indexes: a partial index is only used when the
query repeats its filter, and the range queries here don't need to.

Seller queries use the existing `seller_recent` index for orders placed.
Every query is a bounded aggregation (a `$match` on an indexed range, then a
`$group`). Product lists are capped. There are no per-row queries (no N+1)
and nothing is cached. Every response is `no-store`, like the other
authenticated APIs.

## Limitations

- **Product sales are before refunds.** Refunds are recorded per order, not
  per line.
- **Earnings only appear once settled.** They appear only for orders
  settled under a configured commission policy. Without one, sales are
  reported but earnings and fees are 0, and the screen says how many paid
  orders aren't in the ledger yet.
- **Refunds and sales are separate flows.** A refund counts in the period
  it was processed, which may differ from when the sale happened.
- **Bookings aren't reported.** Service bookings (`service_booking` source
  type) have no booking flow yet, so they appear only through the ledger
  totals if any exist.
- **No usage figures.** Nothing records logins or activity, so there are no
  "active users" metrics.
- **Weeks start on the range's first day**, not on Mondays.
- **Admin financial figures are platform-wide;** there is no per-seller
  admin breakdown, to keep names and other PII out.

## Manual verification

1. Run `npm run db:setup` against the target database (it is idempotent).
2. Log in as a poultry farmer with a few paid, unpaid and cancelled orders
   and open Market → Insights. Check that:
   - paid orders and sales collected match the paid orders on the Sales
     list for the same dates;
   - unpaid orders count only under "Orders placed".
3. Refund part of a delivered order (or cancel a paid one). The refund
   appears in the period it was processed, and the order still counts as
   paid in its own period.
4. Check that the Insights balances equal the Wallet screen exactly.
5. Download each CSV. Check that the totals match the cards, and that a
   product named `=SUM(A1)` appears as `'=SUM(A1)`.
6. Switch to another seller account: none of the first seller's figures
   appear. A buyer-only account (veterinarian) is redirected to the Market.
7. As an admin, open Admin → Analytics:
   - the financial figures reconcile (net captured = paid − refunds);
   - the exception counts match the dashboard.
   A non-admin gets a 404 for both the page and `/api/admin/analytics`.
8. Try a custom range of more than 366 days, or one ending tomorrow: both
   are refused with a message.
