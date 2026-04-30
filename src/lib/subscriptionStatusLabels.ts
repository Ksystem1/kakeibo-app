/** DB / API の英語ステータスを画面用の日本語に（Stripe Subscription.status 相当） */

export const ADMIN_SUBSCRIPTION_STATUSES = [
  "inactive",
  "active",
  "past_due",
  "canceled",
  "trialing",
  "unpaid",
  "paused",
  "admin_free",
] as const;

const SUBSCRIPTION_STATUS_LABEL_JA: Record<string, string> = {
  inactive: "未契約",
  active: "契約中",
  past_due: "支払い遅延",
  canceled: "解約済み",
  trialing: "トライアル中",
  unpaid: "未払い",
  paused: "一時停止",
  admin_free: "追加機能をご利用中",
  /** 互換・外部連携用（API 保存値は admin_free に正規化） */
  admin_granted: "追加機能をご利用中",
};

export function subscriptionStatusLabelJa(value: string): string {
  const v = String(value ?? "").trim();
  return SUBSCRIPTION_STATUS_LABEL_JA[v] ?? v;
}
