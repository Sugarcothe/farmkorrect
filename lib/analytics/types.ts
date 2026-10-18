// Shapes the analytics APIs send. Every amount is an integer number of kobo;
// counts are integers. Definitions are in docs/analytics-reporting.md.
// "Period" figures count events inside the report range; "now" figures are
// the current state whatever the range.

import type { PromotionState } from "@/lib/promotions/types";
import type { PayoutStatus, WalletSummary } from "@/lib/wallet/types";
import type { ReportRange } from "./range";

/** What happened to orders during a period (seller-scoped or marketplace-wide). */
export type OrderActivity = {
  /** created in the period, paid or not */
  placed: number;
  /** paidAt in the period */
  paid: number;
  /** delivered in the period */
  completed: number;
  /** cancelled in the period before any payment (including unpaid orders that expired) */
  cancelledUnpaid: number;
  /** cancelled in the period after payment */
  cancelledPaid: number;
  /** distinct orders with a refund Paystack confirmed in the period */
  refundedOrders: number;
  /** Σ paidKobo of the paid orders: what buyers actually paid */
  salesKobo: number;
  /** Σ order-time promotion discount of the paid orders */
  discountKobo: number;
  /** paid orders that used a promotion */
  promotionOrders: number;
  /** Σ processed order refunds in the period, as the buyer received them */
  refundsKobo: number;
};

export type TrendPoint = {
  /** first and last Lagos date of the bucket */
  from: string;
  to: string;
  placed: number;
  paidOrders: number;
  salesKobo: number;
  refundsKobo: number;
};

export type ProductPerformance = {
  productId: string;
  name: string;
  units: number;
  orders: number;
  /** line totals less their discount share, before refunds */
  salesKobo: number;
};

export type UnsoldProduct = { productId: string; name: string; live: boolean };

export type PromotionPerformance = {
  promotionId: string;
  name: string;
  /** null when the promotion no longer exists */
  state: PromotionState | null;
  code: string | null;
  paidOrders: number;
  redeemedUses: number;
  /** now: uses held by unpaid orders, not completed uses */
  reservedUsesNow: number;
  discountKobo: number;
  salesKobo: number;
};

export type LedgerFlows = {
  earningsKobo: number;
  feesKobo: number;
  /** the seller's share of refunds, taken from earnings */
  refundsKobo: number;
  /** earnings − fees − refunds */
  netKobo: number;
  payoutsPaidKobo: number;
  /** failed payouts' holds returned to the balance */
  payoutReleasesKobo: number;
};

export type PayoutFigures = {
  /** requested in the period, by their current status */
  requested: Record<PayoutStatus, { count: number; amountKobo: number }>;
  paidInPeriod: { count: number; amountKobo: number };
  failedInPeriod: { count: number; amountKobo: number };
};

export type SellerReport = {
  range: ReportRange;
  generatedAt: string;
  overview: {
    current: OrderActivity;
    /** null when the seller has no order from before the period */
    previous: OrderActivity | null;
    /** now: placed and waiting for payment */
    awaitingPaymentNow: number;
  };
  trend: TrendPoint[];
  products: {
    byUnits: ProductPerformance[];
    bySales: ProductPerformance[];
    /** products with sales in the period */
    soldCount: number;
    unsold: UnsoldProduct[];
    unsoldCount: number;
    /** fewer than MIN_ORDERS_FOR_RANKING paid orders in the period */
    insufficientHistory: boolean;
  };
  earnings: {
    ledger: LedgerFlows;
    /** now: exactly what the Wallet shows */
    balances: WalletSummary;
    /** now: paid orders whose earning isn't in the ledger yet */
    paidNotInLedgerNow: number;
    payouts: PayoutFigures;
  };
  promotions: PromotionPerformance[];
};

export type AdminReport = {
  range: ReportRange;
  generatedAt: string;
  accounts: {
    /** now: registered accounts (not "active users") by role and verification */
    byRole: Array<{ role: string; total: number; verified: number }>;
    newInPeriod: Array<{ role: string; count: number }>;
    newInPreviousPeriod: number | null;
  };
  orders: {
    current: OrderActivity;
    previous: OrderActivity | null;
    paymentStatusNow: Array<{ status: string; count: number }>;
    fulfillmentStatusNow: Array<{ status: string; count: number }>;
  };
  trend: Array<TrendPoint & { newAccounts: number }>;
  listings: { liveNow: number; hiddenNow: number; archivedNow: number; newInPeriod: number };
  sellers: { withPaidOrders: number; withLiveListingsNow: number; withActivePromotionNow: number };
  promotions: { byStatusNow: Array<{ status: string; count: number }> };
  financial: {
    paidKobo: number;
    refundsKobo: number;
    /** paidKobo − refundsKobo for the period (a flow, not a balance) */
    netCapturedKobo: number;
    latePaymentsReturned: { count: number; amountKobo: number };
    refundsInProgressNow: { count: number; amountKobo: number };
    refundsFailed: { count: number; amountKobo: number };
    ledger: LedgerFlows;
    /** buyer refunds − the sellers' share, for refund entries recorded in the period */
    feesReturnedKobo: number;
    payouts: {
      requested: { count: number; amountKobo: number };
      paid: { count: number; amountKobo: number };
      failed: { count: number; amountKobo: number };
      inProgressNow: { count: number; amountKobo: number };
    };
  };
  operational: {
    openIssues: number;
    flaggedOrders: number;
    flaggedPayouts: number;
    failedDeliveries: number;
    ledgerSyncPending: number;
    paidNotInLedger: number;
  };
};

export type SellerReportResponse = { report: SellerReport };
export type AdminReportResponse = { report: AdminReport };

export const MIN_ORDERS_FOR_RANKING = 3;
export const TOP_PRODUCTS = 10;
export const UNSOLD_SHOWN = 50;
/** most rows in any CSV export (and products/promotions considered) */
export const CSV_ROW_LIMIT = 1000;

export const SELLER_EXPORTS = ["trend", "products", "promotions"] as const;
export type SellerExport = (typeof SELLER_EXPORTS)[number];
export const ADMIN_EXPORTS = ["trend"] as const;
export type AdminExport = (typeof ADMIN_EXPORTS)[number];
