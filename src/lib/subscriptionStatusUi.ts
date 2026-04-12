import { subscriptionStatusLabelJa } from "./subscriptionStatusLabels";

/**
 * 設定画面「プレミアム（サブスクリプション）状態」行の説明文
 */
export function formatSettingsSubscriptionSummary(user: {
  subscriptionStatus?: string;
  subscriptionPeriodEndAt?: string | null;
  subscriptionCancelAtPeriodEnd?: boolean;
}): string {
  const status = String(user.subscriptionStatus ?? "inactive").trim().toLowerCase();
  const label = subscriptionStatusLabelJa(status);
  const endRaw = user.subscriptionPeriodEndAt;
  const end =
    endRaw != null && String(endRaw).trim() !== ""
      ? new Date(String(endRaw))
      : null;
  const endOk = end != null && Number.isFinite(end.getTime());
  const endStr = endOk
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(end!)
    : null;

  if ((status === "active" || status === "trialing") && user.subscriptionCancelAtPeriodEnd && endStr) {
    return `${label} — 解約予定です。月末まで利用可能です（請求期間の終了日: ${endStr}。月の途中で解約しても、その請求期間の終わりまではご利用いただけます）。`;
  }
  if ((status === "active" || status === "trialing") && !user.subscriptionCancelAtPeriodEnd) {
    return `${label}${endStr ? `（次の請求期間終了: ${endStr}）` : ""}`;
  }
  if (status === "canceled" && endOk && Date.now() <= end!.getTime()) {
    return `${label} — ${endStr}まで引き続きプレミアムをご利用いただけます。`;
  }
  return label;
}
