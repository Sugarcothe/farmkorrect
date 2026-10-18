import { getDb } from "@/lib/server/db";
import {
  type AdminAuditDoc,
  type BankVerificationDoc,
  COLLECTIONS,
  type FarmDoc,
  type FulfillmentDoc,
  type LedgerEntryDoc,
  type NotificationDeliveryDoc,
  type NotificationDoc,
  type NotificationPreferencesDoc,
  type OrderDoc,
  type OtpChallengeDoc,
  type PayoutAccountDoc,
  type PaymentDoc,
  type PayoutDoc,
  type ProductDoc,
  type PromotionDoc,
  type PromotionRedemptionDoc,
  type ProviderEventDoc,
  type PushSubscriptionDoc,
  type PasswordResetDoc,
  type RefundDoc,
  type ReviewDoc,
  type ServiceDoc,
  type SessionDoc,
  type UserDoc,
  type WalletAccountDoc,
} from "@/lib/server/models";

/** Direct collection access for asserting on (and adjusting) stored state. */
export async function collections() {
  const db = await getDb();
  return {
    users: db.collection<UserDoc>(COLLECTIONS.users),
    sessions: db.collection<SessionDoc>(COLLECTIONS.sessions),
    otp: db.collection<OtpChallengeDoc>(COLLECTIONS.otpChallenges),
    resets: db.collection<PasswordResetDoc>(COLLECTIONS.passwordResets),
    farms: db.collection<FarmDoc>(COLLECTIONS.farms),
    services: db.collection<ServiceDoc>(COLLECTIONS.services),
    payoutAccounts: db.collection<PayoutAccountDoc>(COLLECTIONS.payoutAccounts),
    bankVerifications: db.collection<BankVerificationDoc>(COLLECTIONS.bankVerifications),
    ledger: db.collection<LedgerEntryDoc>(COLLECTIONS.ledgerEntries),
    fulfillments: db.collection<FulfillmentDoc>(COLLECTIONS.fulfillments),
    wallets: db.collection<WalletAccountDoc>(COLLECTIONS.walletAccounts),
    payouts: db.collection<PayoutDoc>(COLLECTIONS.payouts),
    providerEvents: db.collection<ProviderEventDoc>(COLLECTIONS.providerEvents),
    products: db.collection<ProductDoc>(COLLECTIONS.products),
    orders: db.collection<OrderDoc>(COLLECTIONS.orders),
    orderPayments: db.collection<PaymentDoc>(COLLECTIONS.payments),
    refunds: db.collection<RefundDoc>(COLLECTIONS.refunds),
    reviews: db.collection<ReviewDoc>(COLLECTIONS.reviews),
    notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
    deliveries: db.collection<NotificationDeliveryDoc>(COLLECTIONS.notificationDeliveries),
    notificationPreferences: db.collection<NotificationPreferencesDoc>(COLLECTIONS.notificationPreferences),
    pushSubscriptions: db.collection<PushSubscriptionDoc>(COLLECTIONS.pushSubscriptions),
    adminAudit: db.collection<AdminAuditDoc>(COLLECTIONS.adminAudit),
    promotions: db.collection<PromotionDoc>(COLLECTIONS.promotions),
    redemptions: db.collection<PromotionRedemptionDoc>(COLLECTIONS.promotionRedemptions),
  };
}

export async function userByPhone(phone: string) {
  return (await collections()).users.findOne({ phoneNormalized: phone });
}
