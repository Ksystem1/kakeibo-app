/**
 * プレミアム向け: 匿名化グローバル辞書（合計金額の集計のみ）。
 * 明細商品名・メモ・ユーザー ID は保持しない。
 */
import crypto from "node:crypto";
import { normalizeVendorForMatch, normalizeDateYmd } from "./receipt-learn.mjs";

/**
 * 辞書登録・照合用フィンガープリント（店名正規化＋年月のみ。合計は含めず複数候補を束ねる）
 * @param {Record<string, unknown>|null|undefined} summary vendorName / date のみ使用
 * @returns {string|null} 64 hex または登録不可
 */
export function globalReceiptLayoutFingerprint(summary) {
  const vendor = normalizeVendorForMatch(summary?.vendorName ?? "").slice(0, 48);
  if (vendor.length < 2) return null;
  if (/@/.test(vendor)) return null;
  if (/\d{11,}/.test(vendor)) return null;
  const ymd = normalizeDateYmd(summary?.date ?? "");
  const ym = ymd.length >= 7 ? ymd.slice(0, 7) : "0000-00";
  const canonical = JSON.stringify({ v: vendor, ym });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * 辞書照合時: AI 補正後の店名が空でも Textract の店名でキーを揃える（学習時のキーと一致しやすくする）
 * @param {Record<string, unknown>} textractSummary
 * @param {Record<string, unknown>} adjustedSummary
 */
export function mergeSummaryForGlobalFingerprint(textractSummary, adjustedSummary) {
  const tx = textractSummary && typeof textractSummary === "object" ? textractSummary : {};
  const adj = adjustedSummary && typeof adjustedSummary === "object" ? adjustedSummary : {};
  const vendorRaw =
    (adj.vendorName != null && String(adj.vendorName).trim()) ||
    (tx.vendorName != null && String(tx.vendorName).trim()) ||
    "";
  const dateRaw =
    (adj.date != null && String(adj.date).trim()) || (tx.date != null && String(tx.date).trim()) || "";
  const totalRaw = adj.totalAmount != null ? adj.totalAmount : tx.totalAmount;
  return {
    vendorName: vendorRaw || null,
    date: dateRaw || null,
    totalAmount: totalRaw,
  };
}

/**
 * 学習保存時: プライバシー上問題なければグローバル集計を 1 件加算
 * @param {import("mysql2/promise").Pool} pool
 * @param {Record<string, unknown>} summary buildReceiptOcrSnapshot の summary 相当
 */
export async function upsertGlobalReceiptOcrStat(pool, summary) {
  const fp = globalReceiptLayoutFingerprint(summary);
  if (!fp) return;
  const totalRaw = summary?.totalAmount;
  const total = totalRaw != null && Number.isFinite(Number(totalRaw)) ? Math.round(Number(totalRaw)) : NaN;
  if (!Number.isFinite(total) || total <= 0 || total > 99_999_999) return;
  await pool.query(
    `INSERT INTO global_receipt_ocr_corrections
       (layout_fingerprint, suggested_total, hit_count, created_at, updated_at)
     VALUES (?, ?, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       hit_count = hit_count + 1,
       updated_at = NOW()`,
    [fp, total],
  );
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {string|null} fingerprint
 * @param {number} [limit]
 * @returns {Promise<Array<{ total: number; weight: number }>>}
 */
export async function fetchGlobalReceiptTotalsByFingerprint(pool, fingerprint, limit = 8) {
  if (!fingerprint || typeof fingerprint !== "string" || fingerprint.length !== 64) return [];
  const lim = Math.min(20, Math.max(1, Number(limit) || 8));
  const [rows] = await pool.query(
    `SELECT suggested_total AS total, hit_count AS weight
     FROM global_receipt_ocr_corrections
     WHERE layout_fingerprint = ?
     ORDER BY hit_count DESC, suggested_total ASC
     LIMIT ?`,
    [fingerprint, lim],
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      total: Math.round(Number(r.total)),
      weight: Math.max(1, Math.round(Number(r.weight) || 1)),
    }))
    .filter((r) => Number.isFinite(r.total) && r.total > 0);
}

function sumReceiptLineItemAmounts(items) {
  if (!Array.isArray(items)) return NaN;
  let s = 0;
  let any = false;
  for (const it of items) {
    const n = Number(it?.amount);
    if (Number.isFinite(n) && n > 0) {
      s += n;
      any = true;
    }
  }
  return any ? Math.round(s) : NaN;
}

/**
 * プレミアムのみ: 合計金額の候補リスト（ワンタップ用）
 * @param {{ subscriptionActive: boolean; adjustedSummary: Record<string, unknown>; items: unknown[]; globalRows: Array<{ total: number; weight: number }> }} p
 * @returns {Array<{ total: number; label: string; source: string }>}
 */
export function buildReceiptTotalCandidates(p) {
  if (!p?.subscriptionActive) return [];
  const globalRows = Array.isArray(p.globalRows) ? p.globalRows : [];
  const items = Array.isArray(p.items) ? p.items : [];
  const adjustedSummary = p.adjustedSummary && typeof p.adjustedSummary === "object" ? p.adjustedSummary : {};
  const out = [];
  const seen = new Set();
  function add(total, label, source) {
    const t = Math.round(Number(total));
    if (!Number.isFinite(t) || t <= 0) return;
    const key = `${source}:${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ total: t, label, source });
  }

  const main = adjustedSummary.totalAmount;
  if (Number.isFinite(Number(main)) && Number(main) > 0) {
    add(main, "現在の解析結果", "parsed");
  }

  const lineSum = sumReceiptLineItemAmounts(items);
  const mainN = Number(main);
  if (Number.isFinite(lineSum) && lineSum > 0) {
    if (!Number.isFinite(mainN) || Math.abs(lineSum - mainN) >= 1) {
      add(lineSum, "明細の合算", "lines");
    }
  }

  for (const r of globalRows) {
    add(
      r.total,
      `匿名辞書の傾向（参照 ${r.weight}）`,
      "global",
    );
  }

  return out.slice(0, 8);
}
