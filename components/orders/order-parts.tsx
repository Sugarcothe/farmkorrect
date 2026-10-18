import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icons";
import { formatDate } from "@/components/wallet/wallet-parts";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  type FulfillmentStatus,
  type Order,
  type OrderEventName,
  type OrderSummary,
  type PaymentStatus,
  type ProductCategory,
  type ProductUnit,
} from "@/lib/orders/types";
import { offerLabel } from "@/lib/promotions/types";
import { formatKobo } from "@/lib/wallet/money";
import { OrderFulfillmentDetails } from "./fulfillment-parts";

// Pieces shared by the Market, Orders and Sales screens. Every amount and
// status shown comes from the server; nothing here decides one.

export const categoryLabel = (value: ProductCategory) => PRODUCT_CATEGORIES.find((c) => c.value === value)?.label ?? "";
export const unitLabel = (value: ProductUnit) => PRODUCT_UNITS.find((u) => u.value === value)?.label ?? "";
/** "crate", "bird"… for "3 crates" style counts */
export const unitName = (value: ProductUnit, count: number) => {
  const name = value === "kg" ? "kg" : value;
  return count === 1 || value === "kg" ? name : `${name}s`;
};

const TONES = {
  neutral: "bg-foreground/6 text-foreground/65",
  waiting: "bg-amber-50 text-amber-800",
  good: "bg-accent/12 text-primary",
  bad: "bg-red-50 text-red-700",
} as const;

const PAYMENT: Record<PaymentStatus, { label: string; tone: keyof typeof TONES }> = {
  pending: { label: "Awaiting payment", tone: "waiting" },
  failed: { label: "Payment failed", tone: "bad" },
  paid: { label: "Paid", tone: "good" },
  cancelled: { label: "Not paid", tone: "neutral" },
  refunded: { label: "Refunded", tone: "neutral" },
  partially_refunded: { label: "Partly refunded", tone: "neutral" },
};

const FULFILLMENT: Record<FulfillmentStatus, { label: string; tone: keyof typeof TONES }> = {
  pending: { label: "Not started", tone: "neutral" },
  processing: { label: "Accepted", tone: "waiting" },
  in_transit: { label: "On the way", tone: "waiting" },
  delivered: { label: "Delivered", tone: "good" },
  cancelled: { label: "Cancelled", tone: "bad" },
};

function Badge({ label, tone }: { label: string; tone: keyof typeof TONES }) {
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${TONES[tone]}`}>{label}</span>
  );
}

export const PaymentBadge = ({ status }: { status: PaymentStatus }) => <Badge {...PAYMENT[status]} />;
export const FulfillmentBadge = ({ status }: { status: FulfillmentStatus }) => <Badge {...FULFILLMENT[status]} />;

export function OrderRow({ order, href }: { order: OrderSummary; href: string }) {
  const party = order.viewer === "buyer" ? `From ${order.sellerName}` : `For ${order.buyerName}`;
  const others = order.itemCount > 1 ? ` + ${order.itemCount - 1} more` : "";
  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-3 px-4 py-3.5 outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
          <Icon name="egg" className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {order.firstItem}
            {others}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {party} · {formatDate(order.createdAt)}
          </p>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">{order.number}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-semibold tabular-nums">{formatKobo(order.totalKobo)}</span>
          <PaymentBadge status={order.paymentStatus} />
          {order.fulfillmentStatus !== "pending" && <FulfillmentBadge status={order.fulfillmentStatus} />}
        </div>
      </Link>
    </li>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl bg-white px-4 py-4 shadow-sm ring-1 ring-foreground/5">
      {title && <h3 className="mb-3 text-sm font-semibold">{title}</h3>}
      {children}
    </section>
  );
}

/**
 * The items, their stored prices and the total (no delivery fee or tax is
 * added). A promotion is shown as it was when the order was placed.
 */
export function OrderItems({ order }: { order: Order }) {
  return (
    <Card title="Items">
      <ul className="space-y-2.5">
        {order.items.map((item) => (
          <li key={item.productId} className="flex justify-between gap-3 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{item.name}</span>
              <span className="block text-xs text-muted-foreground">
                {item.quantity} × {formatKobo(item.unitPriceKobo)} {unitLabel(item.unit)}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              {formatKobo(item.lineTotalKobo)}
              {item.discountKobo > 0 && (
                <span className="block text-xs text-primary">−{formatKobo(item.discountKobo)} off</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {order.promotion && order.discountKobo > 0 && (
        <div className="mt-3 space-y-1 border-t border-foreground/8 pt-3 text-sm">
          <p className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{formatKobo(order.totalKobo + order.discountKobo)}</span>
          </p>
          <p className="flex justify-between gap-3 text-primary">
            <span>
              {order.promotion.code ? `Code ${order.promotion.code}` : order.promotion.name}
              <span className="block text-xs text-muted-foreground">
                Seller&rsquo;s discount ({offerLabel(order.promotion, formatKobo)})
              </span>
            </span>
            <span className="tabular-nums">−{formatKobo(order.discountKobo)}</span>
          </p>
        </div>
      )}
      <div className="mt-3 flex justify-between border-t border-foreground/8 pt-3 text-sm font-semibold">
        <span>Total</span>
        <span className="tabular-nums">{formatKobo(order.totalKobo)}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Delivery is arranged with the seller; no fee is added here.</p>
      {order.refundedKobo > 0 && (
        <p className="mt-2 flex justify-between text-sm">
          <span>Refunded</span>
          <span className="tabular-nums">−{formatKobo(order.refundedKobo)}</span>
        </p>
      )}
      {order.refundPendingKobo > 0 && (
        <p className="mt-1 text-xs text-amber-800">
          A refund of {formatKobo(order.refundPendingKobo)} is being processed by Paystack.
        </p>
      )}
    </Card>
  );
}

const EVENTS: Record<OrderEventName, string> = {
  created: "Order placed",
  payment_started: "Payment started",
  payment_failed: "Payment attempt failed",
  paid: "Payment confirmed by Paystack",
  processing: "Accepted by the seller",
  in_transit: "Sent for delivery",
  delivered: "Marked delivered",
  cancelled: "Cancelled",
  expired: "Cancelled: not paid in time",
  stock_released: "Stock returned to the seller",
  refund_requested: "Refund requested",
  refund_processed: "Refund completed",
  refund_failed: "Refund failed",
  late_payment_refunded: "Late payment refunded",
  issue_reported: "Problem reported",
  issue_closed: "Problem resolved",
};

const ACTORS = { buyer: "Buyer", seller: "Seller", system: "Farm Korret" } as const;

export function OrderHistory({ order }: { order: Order }) {
  return (
    <Card title="History">
      <ol className="space-y-2">
        {[...order.history].reverse().map((h, i) => (
          <li key={`${h.event}-${h.at}-${i}`} className="flex justify-between gap-3 text-xs">
            <span className="font-medium text-foreground/80">{EVENTS[h.event]}</span>
            <span className="shrink-0 text-muted-foreground">
              {ACTORS[h.by]} · {formatDate(h.at, true)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Number, parties and both statuses at the top of an order screen. */
export function OrderHeader({ order }: { order: Order }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{order.number}</p>
          <p className="mt-1 text-sm font-medium">
            {order.viewer === "buyer" ? `Sold by ${order.sellerName}` : `Ordered by ${order.buyerName}`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">Placed {formatDate(order.createdAt, true)}</p>
        </div>
        <span className="text-lg font-semibold tabular-nums">{formatKobo(order.totalKobo)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-foreground/[0.03] px-3 py-2">
          <dt className="text-muted-foreground">Payment</dt>
          <dd className="mt-1">
            <PaymentBadge status={order.paymentStatus} />
          </dd>
        </div>
        <div className="rounded-xl bg-foreground/[0.03] px-3 py-2">
          <dt className="text-muted-foreground">Delivery</dt>
          <dd className="mt-1">
            <FulfillmentBadge status={order.fulfillmentStatus} />
          </dd>
        </div>
      </dl>
      {order.deliveredAt && (
        <p className="mt-2 text-xs text-muted-foreground">Delivered {formatDate(order.deliveredAt, true)}</p>
      )}
      {order.cancelledAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          Cancelled {formatDate(order.cancelledAt, true)}
          {order.cancelledBy ? ` by the ${order.cancelledBy === "system" ? "system" : order.cancelledBy}` : ""}
        </p>
      )}
    </Card>
  );
}

/**
 * Pickup or delivery as agreed when the order was placed, and the buyer's
 * note. Choosing delivery says nothing about whether it was sent: that's the
 * order's status above.
 */
export function DeliveryNote({ order }: { order: Order }) {
  return (
    <Card title="Pickup & delivery">
      <OrderFulfillmentDetails fulfillment={order.fulfillment} />
      <h4 className="mt-3 text-xs font-medium text-foreground/70">
        {order.viewer === "buyer" ? "Your note to the seller" : "The buyer's note"}
      </h4>
      <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-line text-foreground/80">{order.deliveryNote}</p>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Farm Korret doesn&rsquo;t calculate or collect delivery fees. Any delivery charge is agreed directly between buyer and
        seller.
      </p>
    </Card>
  );
}

export function IssueNotice({ order }: { order: Order }) {
  if (!order.issue) return null;
  return (
    <div
      className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${order.issue.open ? "bg-amber-50 text-amber-900" : "bg-foreground/5 text-foreground/75"}`}
    >
      <p className="font-semibold">{order.issue.open ? "Problem reported, under review" : "Reported problem resolved"}</p>
      <p className="mt-1 whitespace-pre-line">{order.issue.note}</p>
      <p className="mt-1 text-xs opacity-75">Reported {formatDate(order.issue.reportedAt, true)}</p>
    </div>
  );
}
