/** クライアント側: プレミアム機能の利用可否（backend subscription-logic と同じ判定） */

export function subscriptionPeriodEndMsFromUser(user: {
  subscriptionPeriodEndAt?: string | null;
} | null | undefined): number | null {
  if (!user) return null;
  const raw = user.subscriptionPeriodEndAt;
  if (raw == null || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  if (/^\d{10}$/.test(s)) {
    return Number(s) * 1000;
  }
  if (/^\d{13}$/.test(s)) {
    return Number(s);
  }
  const end = new Date(s);
  if (!Number.isFinite(end.getTime())) return null;
  return end.getTime();
}

/**
 * Stripe 準拠: active / past_due / trialing は期間終了前まで利用可。canceled も current_period_end までは利用可。
 */
export function isSubscriptionServiceSubscribedClient(
  user: {
    subscriptionStatus?: string;
    subscriptionPeriodEndAt?: string | null;
  } | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!user) return false;
  const s = String(user.subscriptionStatus ?? "inactive").trim().toLowerCase();
  if (s === "admin_free" || s === "admin_granted") return true;
  const endMs = subscriptionPeriodEndMsFromUser(user);
  if (endMs != null && nowMs > endMs) return false;
  if (s === "active" || s === "past_due" || s === "trialing") return true;
  if (s === "canceled" && endMs != null && nowMs <= endMs) return true;
  return false;
}

