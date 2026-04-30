/**
 * プレミアム向け: 匿名化グローバル辞書（合計金額の集計のみ）。
 * 明細商品名・メモ・ユーザー ID は保持しない。
 */
import crypto from "node:crypto";
import { normalizeVendorForMatch, normalizeDateYmd } from "./receipt-learn.mjs";

function fingerprintFromVendorYm(vendor, ym) {
  const canonical = JSON.stringify({ v: vendor, ym });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseYm(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  const dt = new Date(`${ym}-01T00:00:00Z`);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function shiftYm(ym, diffMonths) {
  const base = parseYm(ym);
  if (!base) return ym;
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const moved = new Date(Date.UTC(y, m + diffMonths, 1));
  const yy = moved.getUTCFullYear();
  const mm = String(moved.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function vendorAndYmFromSummary(summary) {
  const vendor = normalizeVendorForMatch(summary?.vendorName ?? "").slice(0, 48);
  if (vendor.length < 2) return null;
  if (/@/.test(vendor)) return null;
  if (/\d{11,}/.test(vendor)) return null;
  const ymd = normalizeDateYmd(summary?.date ?? "");
  const ym = ymd.length >= 7 ? ymd.slice(0, 7) : "0000-00";
  return { vendor, ym };
}

/**
 * 辞書登録・照合用フィンガープリント（店名正規化＋年月のみ。合計は含めず複数候補を束ねる）
 * @param {Record<string, unknown>|null|undefined} summary vendorName / date のみ使用
 * @returns {string|null} 64 hex または登録不可
 */
export function globalReceiptLayoutFingerprint(summary) {
  const p = vendorAndYmFromSummary(summary);
  if (!p) return null;
  return fingerprintFromVendorYm(p.vendor, p.ym);
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

/**
 * ヒット率改善: 同店名の前後 1 ヶ月も検索し、近傍月は重みを少し下げて合算する。
 * @param {import("mysql2/promise").Pool} pool
 * @param {Record<string, unknown>|null|undefined} summary
 * @param {number} [limit]
 * @returns {Promise<{ rows: Array<{ total: number; weight: number }>; hitCount: number }>}
 */
export async function fetchGlobalReceiptTotalsBySummaryWindow(pool, summary, limit = 8) {
  const p = vendorAndYmFromSummary(summary);
  if (!p) return { rows: [], hitCount: 0 };
  const lim = Math.min(20, Math.max(1, Number(limit) || 8));
  const ymList = p.ym === "0000-00" ? [p.ym] : [shiftYm(p.ym, -1), p.ym, shiftYm(p.ym, 1)];
  const ymWeight = new Map([
    [p.ym, 1.0],
    [shiftYm(p.ym, -1), 0.65],
    [shiftYm(p.ym, 1), 0.65],
  ]);
  const totals = new Map();
  let hitCount = 0;
  for (const ym of ymList) {
    const fp = fingerprintFromVendorYm(p.vendor, ym);
    const rows = await fetchGlobalReceiptTotalsByFingerprint(pool, fp, lim);
    hitCount += rows.length;
    const w = ymWeight.get(ym) ?? 1;
    for (const r of rows) {
      const t = Math.round(Number(r.total));
      const cur = totals.get(t) ?? 0;
      totals.set(t, cur + Math.max(1, Number(r.weight) || 1) * w);
    }
  }
  const merged = [...totals.entries()]
    .map(([total, score]) => ({ total, weight: Math.max(1, Math.round(score)) }))
    .sort((a, b) => b.weight - a.weight || a.total - b.total)
    .slice(0, lim);
  return { rows: merged, hitCount };
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
      const ratio = Number.isFinite(mainN) && mainN > 0 ? lineSum / mainN : 1;
      // 小計行・合計行が明細に混ざると合算が膨らむため、差が大きいときは候補に出さない
      if (!Number.isFinite(ratio) || (ratio >= 0.75 && ratio <= 1.35)) {
        add(lineSum, "明細の合算", "lines");
      }
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
