/**
 * 機能権限の表示名（UI 層のみ）。
 * feature_permissions.feature_key と対応。バックエンドのキー・DB は変更しない。
 */

import type { FeaturePermissionSummaryItem } from "../lib/api";

export type FeatureDisplayLocale = "ja" | "en";

/** 日本語（既定）。文言変更は主にこのマップで管理する */
const LABEL_JA: Record<string, string> = {
  receipt_ai: "レシートAI",
  export_csv: "PayPay履歴などの取込・CSV書き出し",
  support_chat: "サポートチャット",
  medical_deduction_csv: "医療費控除CSV（集計の書き出し） (Beta)",
};

/** 英語（将来用・未設定キーはフォールバック） */
const LABEL_EN: Record<string, string> = {
  receipt_ai: "Receipt AI",
  export_csv: "PayPay & other CSV import / export",
  support_chat: "Support chat",
  medical_deduction_csv: "Medical expense deduction CSV export (Beta)",
};

function normalizeFeatureKey(featureKey: string): string {
  return String(featureKey).trim().toLowerCase();
}

function staticLabelForLocale(locale: FeatureDisplayLocale, keyNorm: string): string | undefined {
  const map = locale === "en" ? LABEL_EN : LABEL_JA;
  return map[keyNorm];
}

/**
 * API が返す summary の labelJa をフォールバックに使う（デプロイなしで DB 側だけ更新した場合など）
 */
function labelJaFromItems(items: FeaturePermissionSummaryItem[] | null, keyNorm: string): string | null {
  if (!items?.length) return null;
  const row = items.find((it) => normalizeFeatureKey(it.feature) === keyNorm);
  const ja = row?.labelJa?.trim();
  return ja || null;
}

/**
 * ユーザー向けの機能表示名を返す。
 * 優先順: 静的辞書（選択ロケール）→ API の labelJa（主に日本語の補助）→ feature_key そのもの
 */
export function resolveFeatureDisplayName(
  featureKey: string,
  options: {
    locale?: FeatureDisplayLocale;
    /** GET /feature-permissions の items（省略可） */
    summaryItems?: FeaturePermissionSummaryItem[] | null;
  } = {},
): string {
  const locale = options.locale ?? "ja";
  const keyNorm = normalizeFeatureKey(featureKey);
  if (!keyNorm) return featureKey;

  const fromStatic = staticLabelForLocale(locale, keyNorm);
  if (fromStatic) return fromStatic;

  if (locale === "ja") {
    const fromApi = labelJaFromItems(options.summaryItems ?? null, keyNorm);
    if (fromApi) return fromApi;
  }

  return featureKey.trim() || keyNorm;
}
