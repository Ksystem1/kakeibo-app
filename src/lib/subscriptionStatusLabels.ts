/** DB / API の英語ステータスを画面用の日本語に（Stripe Subscription.status 相当） */

export const ADMIN_SUBSCRIPTION_STATUSES = [
  "inactive",
  "active",
  "past_due",
  "canceled",
  "trialing",
  "unpaid",
  "paused",
] as const;

const SUBSCRIPTION_STATUS_LABEL_JA: Record<string, string> = {
  inactive: "未契約",
  active: "有効",
  past_due: "支払い遅延",
  canceled: "解約済み",
  trialing: "トライアル中",
  unpaid: "未払い",
  paused: "一時停止",
};

export function subscriptionStatusLabelJa(value: string): string {
  const v = String(value ?? "").trim();
  return SUBSCRIPTION_STATUS_LABEL_JA[v] ?? v;
}
