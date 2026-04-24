import crypto from "node:crypto";
import { normalizeCategoryNameKey } from "./category-utils.mjs";
import {
  fetchUserExpenseCategoryRows,
  guessCategoryIdByMerchantKeywords,
  fetchCategoryIdFromUserMemoHistory,
  fetchExistingCategoryIdByExternalIds,
} from "./paypay-category-guess.mjs";

function parseCsvLine(line) {
  const cols = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cols.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

function toHalfWidthComparable(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff\u2060]/g, "")
    .trim();
}

function normalizePayPayDateTime(raw) {
  const t = String(raw ?? "").trim().replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6]);
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(mo) ||
    !Number.isFinite(d) ||
    !Number.isFinite(hh) ||
    !Number.isFinite(mm) ||
    !Number.isFinite(ss)
  ) {
    return null;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) {
    return null;
  }
  const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const second = `${date} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return { date, second };
}

function parseAmount(raw) {
  const s = String(raw ?? "").replace(/,/g, "").trim();
  if (!s || s === "-") return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n);
}

function normalizeTransactionId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return s.replace(/^'+|'+$/g, "");
}

function splitCsvLines(csvText) {
  const text = String(csvText ?? "");
  const rows = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const next = text[i + 1];
      if (inQuotes && next === '"') {
        cur += '""';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        cur += ch;
      }
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (cur.trim() !== "") rows.push(cur);
      cur = "";
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") rows.push(cur);
  return rows;
}

function detectHeaderIndexMap(headerCols) {
  /** @type {Record<string, number>} */
  const map = {};
  headerCols.forEach((c, idx) => {
    map[toHalfWidthComparable(c)] = idx;
  });
  const pick = (...candidates) => {
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(map, c)) return map[c];
    }
    return -1;
  };
  return {
    date: pick("取引日"),
    outAmount: pick("出金金額(円)", "出金金額（円）"),
    type: pick("取引内容"),
    merchant: pick("取引先"),
    txId: pick("取引番号"),
  };
}

const PAYPAY_MERGE_TIME_WINDOW_MS = 10 * 60 * 1000;
const SMALL_PAYMENT_THRESHOLD = 500;

function parsePayPaySecondToEpochMs(txSecond) {
  const s = String(txSecond ?? "").trim().replace(" ", "T");
  if (!s) return null;
  const d = new Date(`${s}+09:00`);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getTime();
}

export function buildPayPayImportPlan(csvText, options = {}) {
  const combineSameTimePayments = options.combineSameTimePayments === true;
  const combineSmallSameDayPayments = options.combineSmallSameDayPayments === true;
  const lines = splitCsvLines(csvText);
  if (lines.length === 0) {
    return {
      ok: false,
      error: "CSV が空です。",
      counts: {
        totalRows: 0,
        paymentRows: 0,
        excludedCount: 0,
        aggregatedCount: 0,
      },
      records: [],
      parseErrors: ["CSV が空です。"],
    };
  }
  const header = parseCsvLine(lines[0]);
  const idx = detectHeaderIndexMap(header);
  const missingCols = [];
  if (idx.date < 0) missingCols.push("取引日");
  if (idx.outAmount < 0) missingCols.push("出金金額（円）");
  if (idx.type < 0) missingCols.push("取引内容");
  if (idx.merchant < 0) missingCols.push("取引先");
  if (idx.txId < 0) missingCols.push("取引番号");
  if (missingCols.length > 0) {
    return {
      ok: false,
      error: `PayPay CSV の必須列が不足しています: ${missingCols.join(", ")}`,
      counts: {
        totalRows: Math.max(0, lines.length - 1),
        paymentRows: 0,
        excludedCount: Math.max(0, lines.length - 1),
        aggregatedCount: 0,
      },
      records: [],
      parseErrors: [`不足列: ${missingCols.join(", ")}`],
    };
  }

  const parseErrors = [];
  /** @type {Array<{externalTransactionId: string, txDate: string, txSecond: string, merchantRaw: string, merchantNormalized: string, amount: number, sourceTxIds: string[]}>} */
  const paymentRows = [];
  let excludedCount = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const type = toHalfWidthComparable(cols[idx.type] ?? "");
    if (type !== "支払い") {
      excludedCount += 1;
      continue;
    }
    const txId = normalizeTransactionId(cols[idx.txId] ?? "");
    const merchantRaw = String(cols[idx.merchant] ?? "").trim();
    const merchantNormalized = toHalfWidthComparable(merchantRaw);
    const amount = parseAmount(cols[idx.outAmount]);
    const dt = normalizePayPayDateTime(cols[idx.date] ?? "");
    if (!txId || !merchantNormalized || !dt || !Number.isFinite(amount) || amount == null) {
      excludedCount += 1;
      parseErrors.push(`行${i + 1}: 必須値の解釈に失敗`);
      continue;
    }
    paymentRows.push({
      externalTransactionId: txId,
      txDate: dt.date,
      txSecond: dt.second,
      merchantRaw,
      merchantNormalized,
      amount,
      sourceTxIds: [txId],
    });
  }

  /** @type {Array<{externalTransactionId: string, txDate: string, txSecond: string, merchantRaw: string, merchantNormalized: string, amount: number, sourceTxIds: string[]}>} */
  let records = paymentRows;
  let aggregatedCount = 0;

  if (combineSameTimePayments || combineSmallSameDayPayments) {
    const sortedRows = [...paymentRows].sort((a, b) => a.txSecond.localeCompare(b.txSecond));
    /** @type {Array<{externalTransactionId: string, txDate: string, txSecond: string, merchantRaw: string, merchantNormalized: string, amount: number, sourceTxIds: string[]}>} */
    const merged = [];

    for (const row of sortedRows) {
      let target = null;
      if (combineSameTimePayments) {
        const rowMs = parsePayPaySecondToEpochMs(row.txSecond);
        if (rowMs != null) {
          for (let i = merged.length - 1; i >= 0; i -= 1) {
            const candidate = merged[i];
            if (candidate.merchantNormalized !== row.merchantNormalized) continue;
            const candMs = parsePayPaySecondToEpochMs(candidate.txSecond);
            if (candMs == null) continue;
            if (rowMs - candMs > PAYPAY_MERGE_TIME_WINDOW_MS) break;
            if (rowMs >= candMs && rowMs - candMs <= PAYPAY_MERGE_TIME_WINDOW_MS) {
              target = candidate;
              break;
            }
          }
        }
      }
      if (!target && combineSmallSameDayPayments && row.amount < SMALL_PAYMENT_THRESHOLD) {
        for (let i = merged.length - 1; i >= 0; i -= 1) {
          const candidate = merged[i];
          if (candidate.merchantNormalized !== row.merchantNormalized) continue;
          if (candidate.txDate !== row.txDate) continue;
          target = candidate;
          break;
        }
      }
      if (!target) {
        merged.push({ ...row, sourceTxIds: [...row.sourceTxIds] });
      } else {
        target.amount += row.amount;
        target.sourceTxIds.push(...row.sourceTxIds);
      }
    }

    records = merged.map((r) => {
      const ids = [...new Set(r.sourceTxIds)];
      if (ids.length <= 1) {
        return { ...r, sourceTxIds: ids, externalTransactionId: ids[0] ?? r.externalTransactionId };
      }
      const hash = crypto
        .createHash("sha1")
        .update(`${r.txDate}|${r.txSecond}|${r.merchantNormalized}|${ids.join("|")}`)
        .digest("hex")
        .slice(0, 12);
      return {
        ...r,
        sourceTxIds: ids,
        externalTransactionId: `paypay-group:${r.txDate}:${hash}`,
      };
    });
    aggregatedCount = paymentRows.length - records.length;
  }

  // external_transaction_id が重複したら後勝ち（同一取引番号の更新扱い）
  const byExtId = new Map();
  for (const r of records) byExtId.set(r.externalTransactionId, r);
  const deduped = Array.from(byExtId.values());

  return {
    ok: true,
    error: null,
    counts: {
      totalRows: Math.max(0, lines.length - 1),
      paymentRows: paymentRows.length,
      excludedCount: excludedCount + (records.length - deduped.length),
      aggregatedCount,
    },
    records: deduped,
    parseErrors,
  };
}

/**
 * メモは店舗名のみ（短形式）。日時・取引番号は transaction_date / external_transaction_id に保存。
 * @param {string} merchantRaw
 * @param {boolean} combined 複数決済の合算行
 */
function buildMemo(merchantRaw, combined) {
  const m = String(merchantRaw ?? "").trim() || "（取引先なし）";
  const base = combined
    ? `PayPay支払い: ${m} (複数決済を合算)`
    : `PayPay支払い: ${m}`;
  return base.slice(0, 500);
}

async function fetchExistingExternalIds(pool, userId, externalIds) {
  if (externalIds.length === 0) return new Set();
  const out = new Set();
  const chunkSize = 300;
  for (let i = 0; i < externalIds.length; i += chunkSize) {
    const chunk = externalIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT external_transaction_id FROM transactions WHERE user_id = ? AND external_transaction_id IN (${placeholders})`,
      [userId, ...chunk],
    );
    for (const r of rows || []) {
      const id = String(r.external_transaction_id ?? "").trim();
      if (id) out.add(id);
    }
  }
  return out;
}

async function bulkUpsertTransactions(pool, rows) {
  if (rows.length === 0) return;
  const chunkSize = 250;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "(?, ?, ?, 'expense', ?, ?, ?, ?, ?)").join(",");
    const params = [];
    for (const r of chunk) {
      params.push(
        r.userId,
        r.familyId,
        null,
        r.amount,
        r.transactionDate,
        r.memo,
        r.categoryId != null && r.categoryId !== undefined ? r.categoryId : null,
        r.externalTransactionId,
      );
    }
    await pool.query(
      `INSERT INTO transactions
       (user_id, family_id, account_id, kind, amount, transaction_date, memo, category_id, external_transaction_id)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         family_id = VALUES(family_id),
         account_id = VALUES(account_id),
         kind = VALUES(kind),
         amount = VALUES(amount),
         transaction_date = VALUES(transaction_date),
         memo = VALUES(memo),
         category_id = COALESCE(category_id, VALUES(category_id)),
         updated_at = NOW()`,
      params,
    );
  }
}

/**
 * 既存で category 済みは維持。未設定のみ履歴 → キーワード推測。
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} userId
 * @param {Array<Record<string, unknown>>} planRecords
 * @param {Array<{ userId: number, familyId: number | null, externalTransactionId: string, amount: number, transactionDate: string, memo: string, categoryId?: number | null }>} builtRows
 * @param {boolean} dryRun
 */
async function applyPayPayCategoryResolution(pool, userId, planRecords, builtRows, dryRun) {
  if (dryRun) {
    for (const r of builtRows) {
      r.categoryId = null;
    }
    return;
  }
  const catRows = await fetchUserExpenseCategoryRows(pool, userId);
  const nameToId = new Map();
  for (const c of catRows) {
    nameToId.set(normalizeCategoryNameKey(c.name), Number(c.id));
  }
  const extIds = builtRows.map((r) => r.externalTransactionId);
  const existingMap = await fetchExistingCategoryIdByExternalIds(pool, userId, extIds);
  /** @type {Map<string, number | null>} */
  const memoHistCache = new Map();
  for (let i = 0; i < builtRows.length; i += 1) {
    const r = builtRows[i];
    const pr = planRecords[i];
    const ext = r.externalTransactionId;
    const existing = existingMap.get(ext);
    if (existing != null && existing !== undefined && Number.isFinite(Number(existing)) && Number(existing) > 0) {
      r.categoryId = Number(existing);
      continue;
    }
    const fromHist = await fetchCategoryIdFromUserMemoHistory(pool, userId, r.memo, memoHistCache);
    if (fromHist != null) {
      r.categoryId = fromHist;
      continue;
    }
    const merchant = pr && typeof pr.merchantRaw === "string" ? pr.merchantRaw : "";
    r.categoryId = guessCategoryIdByMerchantKeywords(merchant, nameToId);
  }
}

export async function writePayPayMonitorLog(pool, row) {
  await pool.query(
    `INSERT INTO monitor_logs
      (log_type, user_id, import_target, action_type, total_rows, new_count, updated_count, aggregated_count, excluded_count, error_count, detail_json)
     VALUES ('paypay_import', ?, 'paypay_csv', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.userId,
      row.actionType,
      row.totalRows,
      row.newCount,
      row.updatedCount,
      row.aggregatedCount,
      row.excludedCount,
      row.errorCount,
      JSON.stringify(row.detail ?? {}),
    ],
  );
}

export async function executePayPayCsvImport(pool, payload) {
  const {
    userId,
    familyId,
    csvText,
    combineSameTimePayments = false,
    combineSmallSameDayPayments = false,
    dryRun = false,
  } = payload;
  const plan = buildPayPayImportPlan(csvText, {
    combineSameTimePayments,
    combineSmallSameDayPayments,
  });
  if (!plan.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: "PayPayCsvParseError",
      detail: plan.error ?? "CSV の解析に失敗しました。",
      counts: {
        totalRows: plan.counts.totalRows,
        newCount: 0,
        updatedCount: 0,
        aggregatedCount: plan.counts.aggregatedCount,
        excludedCount: plan.counts.excludedCount,
        errorCount: plan.parseErrors.length,
      },
      parseErrors: plan.parseErrors.slice(0, 20),
    };
  }

  const rows = plan.records.map((r) => ({
    userId,
    familyId,
    externalTransactionId: r.externalTransactionId,
    amount: r.amount,
    transactionDate: r.txDate,
    memo: buildMemo(r.merchantRaw, r.sourceTxIds.length > 1),
    categoryId: /** @type {number | null} */ (null),
  }));
  await applyPayPayCategoryResolution(pool, userId, plan.records, rows, dryRun);
  const extIds = rows.map((r) => r.externalTransactionId);
  const existingIds = await fetchExistingExternalIds(pool, userId, extIds);
  const updatedCount = rows.filter((r) => existingIds.has(r.externalTransactionId)).length;
  const newCount = rows.length - updatedCount;

  if (!dryRun) {
    await bulkUpsertTransactions(pool, rows);
  }

  return {
    ok: true,
    statusCode: 200,
    counts: {
      totalRows: plan.counts.totalRows,
      newCount,
      updatedCount,
      aggregatedCount: plan.counts.aggregatedCount,
      excludedCount: plan.counts.excludedCount,
      errorCount: plan.parseErrors.length,
    },
    parseErrors: plan.parseErrors.slice(0, 20),
    combineSameTimePayments,
    combineSmallSameDayPayments,
  };
}
