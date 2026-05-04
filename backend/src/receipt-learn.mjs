import crypto from "node:crypto";

function normalizeToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "");
}

/**
 * vendorName がネストオブジェクト・メタデータ付きで渡る場合に、[object Object] にならないよう文字列へ潰す。
 * @param {unknown} input
 * @param {number} depth
 * @returns {string}
 */
export function coerceVendorNameInputToPlainString(input, depth = 0) {
  if (input == null) return "";
  if (typeof input === "string") return input.trim();
  if (typeof input === "number" && Number.isFinite(input)) return String(input);
  if (typeof input === "boolean") return input ? "true" : "false";
  if (typeof input === "object" && depth <= 2) {
    const o = /** @type {Record<string, unknown>} */ (input);
    const keys = [
      "vendorName",
      "name",
      "storeName",
      "label",
      "displayName",
      "value",
      "text",
      "vendorNorm",
    ];
    for (const k of keys) {
      if (!(k in o)) continue;
      const sub = o[k];
      if (typeof sub === "string" && sub.trim()) return sub.trim();
      if (typeof sub === "number" && Number.isFinite(sub)) return String(sub);
      if (typeof sub === "object" && sub != null) {
        const inner = coerceVendorNameInputToPlainString(sub, depth + 1);
        if (inner) return inner;
      }
    }
    return "";
  }
  return String(input).trim();
}

/** グローバル辞書の照合・学習で共有する正規化（個人メモは使わない） */
export function normalizeVendorForMatch(s) {
  const plain = coerceVendorNameInputToPlainString(s);
  return normalizeToken(plain)
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
    vendorName:
      summary?.vendorName != null
        ? coerceVendorNameInputToPlainString(summary.vendorName) || null
        : null,
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
