/** PayPay 明細エクスポート（1行目に含まれる列名の目印） */
const PAYPAY_REQUIRED_HEADERS = ["取引日", "取引内容", "取引先", "取引番号"] as const;

/**
 * 先頭行が PayPay 取引 CSV の列構成に近いか（厳密な MIME や拡張子に依存しない）
 */
export function looksLikePayPayCsv(text: string): boolean {
  const firstLine = String(text ?? "").split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.trim()) return false;
  return PAYPAY_REQUIRED_HEADERS.every((h) => firstLine.includes(h));
}
