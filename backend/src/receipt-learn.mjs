import crypto from "node:crypto";

function normalizeToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "");
}

function normalizeVendorForMatch(s) {
  return normalizeToken(s)
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "");
}

function normalizeDateYmd(raw) {
  const t = String(raw ?? "")
    .trim()
    .replace(/\//g, "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return "";
}

/**
 * 画面・API 用に取込スナップショットを保持する形へ整形する。
 * @param {object|null|undefined} summary
 * @param {Array<{ name?: string; amount?: number | null }>|undefined} items
 */
export function buildReceiptOcrSnapshot(summary, items) {
  const totalRaw = summary?.totalAmount;
  const total =
    totalRaw != null && Number.isFinite(Number(totalRaw))
      ? Math.round(Number(totalRaw) * 100) / 100
      : null;
  return {
    vendorName: summary?.vendorName != null ? String(summary.vendorName) : null,
    totalAmount: total,
    date: summary?.date != null ? String(summary.date) : null,
    items: Array.isArray(items)
      ? items.map((it) => ({
          name: it?.name != null ? String(it.name) : "",
          amount:
            it?.amount != null && Number.isFinite(Number(it.amount))
              ? Number(it.amount)
              : null,
        }))
      : [],
  };
}

/**
 * 同一レシートとみなすための照合キー（店舗・合計・日付・明細名の集合）。
 * @param {object|null|undefined} summary
 * @param {Array<{ name?: string }>|undefined} items
 */
export function receiptOcrMatchKey(summary, items) {
  const v = normalizeVendorForMatch(summary?.vendorName ?? "");
  const t =
    summary?.totalAmount != null && Number.isFinite(Number(summary.totalAmount))
      ? Math.round(Number(summary.totalAmount))
      : null;
  const d = normalizeDateYmd(summary?.date ?? "");
  const itemPart = (Array.isArray(items) ? items : [])
    .map((it) => normalizeToken(it?.name ?? ""))
    .filter(Boolean)
    .sort()
    .join("|");
  const canonical = JSON.stringify({ v, t, d, itemPart });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
