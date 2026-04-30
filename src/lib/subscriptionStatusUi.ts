import { subscriptionStatusLabelJa } from "./subscriptionStatusLabels";
import { isSubscriptionServiceSubscribedClient, subscriptionPeriodEndMsFromUser } from "./subscriptionAccess";
import {
  formatSubscriptionPeriodEndSlashJst,
  SUBSCRIPTION_PERIOD_END_PENDING_JA,
} from "./subscriptionPeriodEndFormat";

function formatPeriodEndNumericJa(isoOrDate: string | Date): string | null {
  const s = typeof isoOrDate === "string" ? isoOrDate : isoOrDate.toISOString();
  return formatSubscriptionPeriodEndSlashJst(s);
}

/**
 * 設定画面の1行目用: 通常の active では空（「契約中」は出さない）。解約予約・遅延・トライアルのみ文言を出す。
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
    return `終了予定（${SUBSCRIPTION_PERIOD_END_PENDING_JA}）`;
  }

  if (status === "trialing") return subscriptionStatusLabelJa("trialing");
  if (status === "past_due") return subscriptionStatusLabelJa("past_due");
  if (status === "canceled" && endMs != null && now <= endMs) {
    const num = user.subscriptionPeriodEndAt
      ? formatPeriodEndNumericJa(String(user.subscriptionPeriodEndAt))
      : null;
    return num
      ? `${num}まで利用可能`
      : `解約処理中（終了日: ${SUBSCRIPTION_PERIOD_END_PENDING_JA}）`;
  }
  /* active 等: 見出しで十分のため「契約中」は表示しない */
  return "";
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

  if (status === "admin_free" || status === "admin_granted") {
    return "追加機能をご利用いただけます。";
  }
  if ((status === "active" || status === "trialing" || status === "past_due") && user.subscriptionCancelAtPeriodEnd) {
    if (endStr && endNum) {
      return `解約が予約されています。${endNum}まで追加機能をご利用いただけます（請求期間の終了日: ${endStr}）。`;
    }
    return `解約が予約されています。有効期限の日付は${SUBSCRIPTION_PERIOD_END_PENDING_JA}です。表示が追いつかない場合は、お支払いの管理画面で終了日をご確認ください。`;
  }
  if ((status === "active" || status === "trialing" || status === "past_due") && !user.subscriptionCancelAtPeriodEnd) {
    if (status === "active") {
      return endStr ? `次の請求期間終了: ${endStr}` : "";
    }
    return `${label}${endStr ? `（次の請求期間終了: ${endStr}）` : ""}`;
  }
  if (status === "canceled" && endOk && Date.now() <= end!.getTime()) {
    return `${label} — ${endStr}まで引き続き追加機能をご利用いただけます。`;
  }
  return label;
}
