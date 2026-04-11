/**
 * Stripe 等で更新する users.subscription_status と連携。
 * DB 値は小文字推奨（'active' のみ有効扱い）。
 */
export function isSubscriptionActive(subscriptionStatus) {
  return String(subscriptionStatus ?? "").trim().toLowerCase() === "active";
}
