import { subscriptionStatusLabelJa } from "./subscriptionStatusLabels";
import { isSubscriptionServiceSubscribedClient, subscriptionPeriodEndMsFromUser } from "./subscriptionAccess";

function formatPeriodEndNumericJa(isoOrDate: string | Date): string | null {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * 設定画面の1行目用: 「契約中」「2026/04/30に終了予定」など（解約予約時は日付表記）
 */
export function formatPremiumSubscriptionPrimaryStatus(user: {
  subscriptionStatus?: string;
  subscriptionPeriodEndAt?: string | null;
  subscriptionCancelAtPeriodEnd?: boolean;
}): string {
  const status = String(user.subscriptionStatus ?? "inactive").trim().toLowerCase();
  const endMs = subscriptionPeriodEndMsFromUser(user);
  const now = Date.now();
  const withinPeriod = endMs == null || now <= endMs;

  if (!isSubscriptionServiceSubscribedClient(user)) {
    return subscriptionStatusLabelJa(status);
  }

  if (user.subscriptionCancelAtPeriodEnd && withinPeriod) {
    const endRaw = user.subscriptionPeriodEndAt;
    if (endRaw != null && String(endRaw).trim() !== "") {
      const num = formatPeriodEndNumericJa(String(endRaw));
      if (num) return `${num}に終了予定`;
    }
  }

  if (status === "trialing") return subscriptionStatusLabelJa("trialing");
  if (status === "past_due") return subscriptionStatusLabelJa("past_due");
  if (status === "canceled" && endMs != null && now <= endMs) {
    const num = user.subscriptionPeriodEndAt
      ? formatPeriodEndNumericJa(String(user.subscriptionPeriodEndAt))
      : null;
    return num ? `${num}まで利用可能` : subscriptionStatusLabelJa("canceled");
  }
  return subscriptionStatusLabelJa("active");
}

/**
 * 設定画面「プレミアム（サブスクリプション）」下の補足説明
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
  const endNum = endOk ? formatPeriodEndNumericJa(end!) : null;

  if ((status === "active" || status === "trialing" || status === "past_due") && user.subscriptionCancelAtPeriodEnd && endStr && endNum) {
    return `解約が予約されています。${endNum}まではプレミアムをご利用いただけます（請求期間の終了日: ${endStr}）。`;
  }
  if ((status === "active" || status === "trialing" || status === "past_due") && !user.subscriptionCancelAtPeriodEnd) {
    return `${label}${endStr ? `（次の請求期間終了: ${endStr}）` : ""}`;
  }
  if (status === "canceled" && endOk && Date.now() <= end!.getTime()) {
    return `${label} — ${endStr}まで引き続きプレミアムをご利用いただけます。`;
  }
  return label;
}
