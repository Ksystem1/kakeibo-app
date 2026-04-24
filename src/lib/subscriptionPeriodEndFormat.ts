/**
 * subscriptionPeriodEndAt（ISO または数値文字列の UNIX 秒）を YYYY/MM/DD（JST）に揃える。
 */
const TZ = "Asia/Tokyo";

function ymdSlashInTokyo(d: Date): string | null {
  if (!Number.isFinite(d.getTime())) return null;
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return s.replace(/-/g, "/");
}

/**
 * 設定画面・管理表示用: 有効期限の日付行（得られなければ null）
 */
export function formatSubscriptionPeriodEndSlashJst(isoOrUnix: string | null | undefined): string | null {
  if (isoOrUnix == null) return null;
  const s = String(isoOrUnix).trim();
  if (s === "") return null;
  if (/^\d{10}$/.test(s)) {
    const d = new Date(Number(s) * 1000);
    return ymdSlashInTokyo(d);
  }
  if (/^\d{13}$/.test(s)) {
    const d = new Date(Number(s));
    return ymdSlashInTokyo(d);
  }
  const d = new Date(s);
  return ymdSlashInTokyo(d);
}

/** 日付が無いときの補足（「不明」は使わない） */
export const SUBSCRIPTION_PERIOD_END_PENDING_JA = "Stripeで確認中";

/** 解約補足の「◯年◯月◯日」用（JST） */
export function formatSubscriptionPeriodEndJaLong(isoOrUnix: string | null | undefined): string | null {
  if (isoOrUnix == null) return null;
  const s = String(isoOrUnix).trim();
  if (s === "") return null;
  let d: Date;
  if (/^\d{10}$/.test(s)) d = new Date(Number(s) * 1000);
  else if (/^\d{13}$/.test(s)) d = new Date(Number(s));
  else d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}
