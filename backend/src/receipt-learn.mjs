import crypto from "node:crypto";

function normalizeToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "");
}

/** グローバル辞書の照合・学習で共有する正規化（個人メモは使わない） */
export function normalizeVendorForMatch(s) {
  return normalizeToken(s)
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "");
}

export function normalizeDateYmd(raw) {
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
      ? items.map((it) => {
          const lineCat =
            it?.lineCategory != null && String(it.lineCategory).trim() !== ""
              ? String(it.lineCategory).trim()
              : it?.category != null && String(it.category).trim() !== ""
                ? String(it.category).trim()
                : null;
          return {
            name: it?.name != null ? String(it.name) : "",
            amount:
              it?.amount != null && Number.isFinite(Number(it.amount))
                ? Number(it.amount)
                : null,
            lineCategory: lineCat,
          };
        })
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

/**
 * 明細行名＋金額で、ユーザーが学習させた行カテゴリを照合するキー
 * @param {string|undefined|null} name
 * @param {unknown} amount
 * @returns {string|null}
 */
export function lineItemLearnKey(name, amount) {
  const t = normalizeToken(name ?? "");
  const a = amount != null && Number.isFinite(Number(amount)) ? Math.round(Number(amount)) : NaN;
  if (!t || !Number.isFinite(a) || a <= 0) return null;
  return `${t}@@${a}`;
}

/**
 * 学習のスキップ判定: 取込内容と行カテゴリが前回と同一なら真
 */
function lineCategoryLearnSignature(snap) {
  return (Array.isArray(snap?.items) ? snap.items : [])
    .map((it) => {
      const k = lineItemLearnKey(it?.name, it?.amount);
      if (!k) return null;
      return `${k}|${String(it?.lineCategory ?? "").trim()}`;
    })
    .filter(Boolean)
    .sort()
    .join("##");
}

export function receiptOcrSnapshotContentEqualForLearn(a, b) {
  if (String(a?.vendorName ?? "") !== String(b?.vendorName ?? "")) return false;
  if (Number(a?.totalAmount ?? NaN) !== Number(b?.totalAmount ?? NaN)) return false;
  if (String(a?.date ?? "") !== String(b?.date ?? "")) return false;
  return lineCategoryLearnSignature(a) === lineCategoryLearnSignature(b);
}
