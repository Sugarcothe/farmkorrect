# Promotions & discounts

Poultry farmers can run sales and coupon codes on their own product listings from the seller dashboard (**Market → My Listings → Promotions & coupon codes**). This note covers how the feature works, where the money goes, and what to do before production.

## Types and eligibility

| Field | Rule |
| --- | --- |
| Type | `percentage` (whole 1–90 %) or `fixed` (₦1–₦10,000,000, stored in kobo) |
| Applies to | `all` of the seller's current product listings, or up to 50 chosen ones |
| Code | Optional. Trimmed and uppercased, 4–20 letters/digits with single inner hyphens, unique across all sellers (unique index). No code means an **automatic sale**. |
| Dates | `startsAt` < `endsAt`, the end must be in the future, a run of at most 366 days, starting within the next 366 days |
| Minimum spend | Optional. Measured on the **eligible** products in the order, not the whole cart |
| Maximum discount | Optional, percentage only (a fixed amount is already its own cap) |
| Total uses / per buyer | Optional; per buyer ≤ total |

- **Products only.** Promotions apply to product listings (`products` collection). Services (`services` collection) can't be ordered or paid for through checkout, so they can't be selected, quoted or discounted. This is covered by the "products and services" test.
- Only the seller's own, non-archived listings can be chosen. Ownership is always taken from the session; ids in the request are only checked against it.
- An order contains one seller's products (existing rule), so a promotion only ever reduces that seller's products.

### Lifecycle

`draft → active ⇄ paused → ended` (ended is final). Only drafts and paused promotions can be edited. Every edit and status change sends `expectedVersion`, so a stale tab gets a 409 rather than overwriting a newer change. A promotion's buyer-facing **state** is derived from its status, dates and limit: `draft`, `scheduled`, `live`, `paused`, `expired`, `used_up` or `ended`. Only `live` promotions reduce prices or show in the Market.

## Selection rule (no stacking)

One promotion per order, chosen by the server:

1. If the buyer enters a code, that code's promotion is used **instead of** any automatic sale. If the code can't be used, the buyer sees why and the price is shown without it. Possible reasons include: not recognised (also used for other sellers' codes and drafts, so codes can't be probed), paused, not started yet, expired, ended, fully used, the buyer's limit reached, no eligible items, below the minimum, or no saving.
2. Without a code, the live automatic sale giving the **largest discount** applies. Ties go to the earliest created. Sales where the buyer has reached their per-buyer limit are skipped.

The browser sends only product ids, quantities and an optional code. It can't send a price, discount, promotion id or seller.

## Calculation

All arithmetic is integer kobo (`lib/promotions/pricing.ts`, shared by the server and the seller's preview):

- `eligibleSubtotal` = the sum of line totals for covered products.
- Percentage: `floor(eligibleSubtotal × value / 100)`, rounded down so a buyer is never promised more than the seller set. Fixed: `value`.
- The discount is then capped by `maxDiscountKobo`, by `eligibleSubtotal`, and by `subtotal − ₦1`, so an order is never free.
- The discount is split across eligible lines pro rata (BigInt, largest remainder), so the per-line shares add up exactly and none exceeds its line. These shares are stored on each order item as `discountKobo`.

## Seller funding and the ledger

Discounts are **seller-funded only**; there are no platform-funded discounts.

- `order.totalKobo` is the discounted amount. It is what Paystack is asked to collect, what the payment must match, and the base the existing ledger uses.
- The seller's earning and the platform fee come from the existing commission logic applied to the amount actually paid. The commission rate, policy and ledger code are unchanged. Example (tested): a 10 % sale on a ₦9,000 order means the buyer pays ₦8,100; with a 5 % commission the ledger records an earning of ₦8,100 and a platform fee of ₦405, exactly as for an undiscounted ₦8,100 order.
- Payouts, wallet, bank details and transfers are untouched.

## Order-time snapshot and integrity

When an order is placed, inside the existing order transaction:

- `order.promotion` stores an immutable snapshot: name, code, type, value, eligible subtotal and discount, plus the promotion id and version.
- Each item gets its `discountKobo` share, and `totalKobo = subtotal − discount`.
- If the browser sent `expectedTotalKobo` and it differs, the order is refused, as before.

Later edits, pauses or ends never change placed orders.

Before checkout, `pricingConsistent(order)` re-checks that the line totals, item discounts, snapshot and `totalKobo` agree. If they don't, the order is flagged for review and payment is refused (409). Payment verification also requires Paystack's amount to equal `totalKobo`; a mismatch leaves the order pending and flagged.

## Use limits and concurrency

Uses are tracked in `promotion_redemptions` (one per order, unique `orderId`) and in `promotions.redemptionCount`:

| Event | Effect |
| --- | --- |
| Order placed (same transaction) | Conditional `$inc` of `redemptionCount` that only matches while the promotion is still active, at the priced version, within its dates and under `totalLimit`. Then a per-buyer count check, then a `reserved` redemption insert. Any failure aborts the whole order (409, "the offer changed"), so there is no partial state. |
| Payment confirmed | `reserved → redeemed` (in the paid transaction). |
| Order cancelled before fulfilment, paid or unpaid, or expired unpaid (the existing stock release) | `→ released`; `redemptionCount` is decremented once. |
| Failed payment, then retry | The order keeps its reservation and price for the existing 30-minute window. A retry pays the same discounted amount and redeems once. |
| Idempotent resubmission | Returns the same order; no second use. |

Unpaid orders hold a use, so the limits can't be beaten by placing many orders at once. This is tested: 6 concurrent buyers against a limit of 3 gives exactly 3 orders, and a buyer racing themself against a per-buyer limit of 1 gives exactly 1.

## Refunds

Refunds work on what was paid (`paidKobo`, which equals the discounted `totalKobo`), never the list price. A cancellation refund returns the discounted amount and gives the use back, through the stock release above. A seller's post-delivery refund is capped at the discounted amount and doesn't give the use back, because the order was fulfilled.

## API

| Route | Who | Purpose |
| --- | --- | --- |
| `GET/POST /api/promotions` | verified seller | list own / create a draft |
| `GET/PATCH /api/promotions/[id]` | owner | read / edit a draft or paused promotion (`expectedVersion`) |
| `POST /api/promotions/[id]/status` | owner | `{ action: activate \| pause \| end, expectedVersion }` |
| `POST /api/orders/quote` | verified user | server-priced quote; reserves nothing |
| `POST /api/orders` | verified buyer | now also accepts optional `couponCode` |

Responses use the existing `{ ok, data | error, fieldErrors }` envelope. New rate limits: `orderQuotesPerUser` (120 per 15 min), `promotionChangesPerUser` (120 per hour) and `promotionReadsPerUser` (300 per 15 min). Promotion changes are seller actions on their own data, so no admin audit entries were added.

## Buyer experience

- **Market.** Live automatic sales show a "10% off" badge. When one unit's price is certain (a percentage with no minimum), the sale price is shown next to the struck-out original. The product page lists the terms: minimum, cap and end time, plus "One offer per order; a coupon code replaces it." Coupon codes, paused, scheduled and expired promotions are never advertised.
- **Checkout.** A coupon field (Apply / Remove), with the subtotal, discount and total from the server's quote. The quote is fetched again just before ordering; if the total moved, the buyer sees the new total instead of being charged it.
- **Order pages** (buyer and seller). Per-line discounts, subtotal, the promotion's name or code, and the total.
- **Admin.** Totals were already the charged amount; the issue detail also shows the seller's discount.

## Database setup

There are no migrations. Existing orders have no `promotion` or `discountKobo` fields and read as "no discount". New collections `promotions` and `promotion_redemptions` and their indexes are created by:

```bash
npm run db:setup
```

Run it before deploying. The unique `code` index and the unique `orderId` index on redemptions are what enforce one code per promotion and one use per order.

## Environment variables

None added. Existing Paystack, commission and job variables are used unchanged.

## Limitations

- One promotion per order, products only, and orders hold one seller's products (existing rule).
- Buyers can't browse coupon codes. Sellers share them themselves.
- Per-buyer limits are per account.
- A Market sale price is shown only when it is certain for one unit. Fixed amounts and minimums show the badge and terms instead.
- Paystack enforces its own minimum charge, which may be above the ₦1 floor here. A heavily discounted tiny order could be refused by Paystack at checkout.
- The seller dashboard shows stats from redemptions (paid, awaiting payment, discount given, buyers paid). There's no time-series reporting.

## Before production

1. Run `npm run db:setup` against the production database.
2. In Paystack test mode, place a discounted order and confirm the charged amount, then the seller's earning and fee in the wallet.
3. Cancel an unpaid discounted order and let one expire; confirm the use is released on the promotion page.
4. Refund a discounted paid order; confirm the refunded amount equals what was paid.
5. Check the seller pages, checkout coupon flow and Market badges on a phone.
