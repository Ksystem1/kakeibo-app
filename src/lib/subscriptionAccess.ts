/** クライアント側: プレミアムナビスキン等の利用可否（/auth/me のフィールドと整合） */

export function hasPremiumNavAccess(user: {
  subscriptionStatus?: string;
  subscriptionPeriodEndAt?: string | null;
} | null): boolean {
  if (!user) return false;
  const s = String(user.subscriptionStatus ?? "inactive").trim().toLowerCase();
  if (s === "active" || s === "trialing" || s === "past_due") return true;
  if (s === "canceled" && user.subscriptionPeriodEndAt) {
    const end = new Date(user.subscriptionPeriodEndAt);
    return Number.isFinite(end.getTime()) && Date.now() <= end.getTime();
  }
  return false;
}
