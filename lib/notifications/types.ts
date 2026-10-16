// Shapes the Notifications API sends and accepts, shared by the browser and
// the server. Notifications are only ever created on the server, from events
// it has already recorded (a verified payment, a status change, a published
// review…); the browser can read them, mark them read and set preferences.

export const NOTIFICATION_CATEGORIES = [
  {
    value: "orders",
    label: "Orders & delivery",
    description: "New orders, acceptance, dispatch, delivery, cancellations and reported problems.",
  },
  {
    value: "payments",
    label: "Payments & refunds",
    description: "Payments received or failed, and refunds being processed, completed or failed.",
  },
  {
    value: "payouts",
    label: "Earnings & payouts",
    description: "Payouts to your bank account being sent, paid or needing attention.",
  },
  {
    value: "security",
    label: "Account security",
    description: "Changes to your bank details and password. These can't be turned off.",
  },
  {
    value: "reviews",
    label: "Reviews & marketplace",
    description: "New reviews on your listings.",
  },
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]["value"];

/** Categories whose notices always go out on every channel that's available. */
export const MANDATORY_CATEGORIES: readonly NotificationCategory[] = ["security"];

/** External channels the user can choose per category (the in-app inbox is always on). */
export const EXTERNAL_CHANNELS = ["email", "sms", "push"] as const;
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];
export type NotificationChannel = "in_app" | ExternalChannel;

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: "In the app",
  email: "Email",
  sms: "SMS",
  push: "Push",
};

export type NotificationIcon =
  | "list"
  | "check-circle"
  | "alert-circle"
  | "wallet"
  | "landmark"
  | "lock"
  | "star"
  | "x"
  | "arrow-left"
  | "store";

/**
 * Every kind of notification. Each one has a fixed category (which decides
 * the preferences that apply), an icon and the external channels it may use.
 * SMS is kept to a few high-priority events.
 */
export const NOTIFICATION_TYPES = {
  // the customer's orders
  order_placed: { category: "orders", icon: "list", channels: [] },
  order_accepted: { category: "orders", icon: "check-circle", channels: ["email", "push"] },
  order_dispatched: { category: "orders", icon: "list", channels: ["email", "sms", "push"] },
  order_delivered: { category: "orders", icon: "check-circle", channels: ["email", "push"] },
  order_cancelled: { category: "orders", icon: "x", channels: ["email", "push"] },
  order_expired: { category: "orders", icon: "x", channels: ["push"] },
  issue_resolved: { category: "orders", icon: "check-circle", channels: ["email", "push"] },
  payment_confirmed: { category: "payments", icon: "check-circle", channels: ["email", "push"] },
  payment_failed: { category: "payments", icon: "alert-circle", channels: ["push"] },
  refund_processing: { category: "payments", icon: "arrow-left", channels: ["email", "push"] },
  refund_completed: { category: "payments", icon: "arrow-left", channels: ["email", "sms", "push"] },
  refund_failed: { category: "payments", icon: "alert-circle", channels: ["email", "push"] },
  late_payment_returned: { category: "payments", icon: "arrow-left", channels: ["email", "push"] },
  // the merchant's sales
  sale_paid: { category: "orders", icon: "store", channels: ["email", "sms", "push"] },
  sale_cancelled: { category: "orders", icon: "x", channels: ["email", "sms", "push"] },
  sale_issue_reported: { category: "orders", icon: "alert-circle", channels: ["email", "sms", "push"] },
  sale_issue_resolved: { category: "orders", icon: "check-circle", channels: ["email", "push"] },
  sale_refund_processing: { category: "payments", icon: "arrow-left", channels: ["email", "push"] },
  sale_refund_completed: { category: "payments", icon: "arrow-left", channels: ["email", "push"] },
  sale_refund_failed: { category: "payments", icon: "alert-circle", channels: ["email", "push"] },
  payout_requested: { category: "payouts", icon: "wallet", channels: [] },
  payout_processing: { category: "payouts", icon: "wallet", channels: ["push"] },
  payout_paid: { category: "payouts", icon: "check-circle", channels: ["email", "sms", "push"] },
  payout_failed: { category: "payouts", icon: "alert-circle", channels: ["email", "sms", "push"] },
  review_published: { category: "reviews", icon: "star", channels: ["email", "push"] },
  // the account
  bank_account_added: { category: "security", icon: "landmark", channels: ["email", "sms", "push"] },
  bank_account_changed: { category: "security", icon: "landmark", channels: ["email", "sms", "push"] },
  password_changed: { category: "security", icon: "lock", channels: ["email", "sms", "push"] },
} as const satisfies Record<
  string,
  { category: NotificationCategory; icon: NotificationIcon; channels: readonly ExternalChannel[] }
>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

/** One notification as the inbox shows it. */
export type Notification = {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  /** an internal path (always starting with a single "/"), or null */
  url: string | null;
  createdAt: string;
  readAt: string | null;
};

export type NotificationFilter = "all" | "unread";

export type NotificationPage = {
  notifications: Notification[];
  page: number;
  hasMore: boolean;
  unreadCount: number;
};

export type UnreadCount = { unreadCount: number };

export type ChannelChoices = Record<ExternalChannel, boolean>;
export type NotificationPreferences = Record<NotificationCategory, ChannelChoices>;

/** Whether a channel can be used at all for this account right now, and why not. */
export type ChannelAvailability = { available: boolean; note: string | null };

export type PreferencesResponse = {
  preferences: NotificationPreferences;
  mandatory: NotificationCategory[];
  channels: Record<ExternalChannel, ChannelAvailability>;
  /** the VAPID public key for subscribing this browser, or null when push isn't set up */
  pushPublicKey: string | null;
};

/** PATCH body: any subset of categories and channels. */
export type PreferencesUpdate = Partial<Record<NotificationCategory, Partial<ChannelChoices>>>;

/**
 * Conservative defaults: SMS only where an event is marked SMS-worthy, no
 * email or push about reviews, nothing promotional (there are no
 * promotional notifications at all).
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  orders: { email: true, sms: true, push: true },
  payments: { email: true, sms: true, push: true },
  payouts: { email: true, sms: true, push: true },
  security: { email: true, sms: true, push: true },
  reviews: { email: false, sms: false, push: true },
};

export const isNotificationCategory = (value: unknown): value is NotificationCategory =>
  typeof value === "string" && NOTIFICATION_CATEGORIES.some((c) => c.value === value);

export const isNotificationType = (value: unknown): value is NotificationType =>
  typeof value === "string" && Object.hasOwn(NOTIFICATION_TYPES, value);

/**
 * An internal path that's safe to navigate to, or null. Only same-site paths
 * are accepted: no scheme, no host, no protocol-relative "//", no
 * backslashes or control characters, so a stored link can never send
 * someone to another site.
 */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\\\s]/.test(value) || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  try {
    const base = "https://internal.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
