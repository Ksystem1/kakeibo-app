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
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = m[4] == null ? 0 : Number(m[4]);
  const mm = m[5] == null ? 0 : Number(m[5]);
  const ss = m[6] == null ? 0 : Number(m[6]);
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

function detectSimplePayPayRowShape(cols) {
  // 例: 2026021400001,2026/02/14,10000,,ＰＡＹＰＡＹ...,601494
  if (!Array.isArray(cols) || cols.length < 3) return false;
  const txId = normalizeTransactionId(cols[0] ?? "");
  const dt = normalizePayPayDateTime(cols[1] ?? "");
  const amount = parseAmount(cols[2] ?? "");
  if (!txId || !dt || amount == null || !Number.isFinite(amount) || amount <= 0) return false;
  return true;
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
  const hasHeaderShape =
    idx.date >= 0 &&
    idx.outAmount >= 0 &&
    idx.type >= 0 &&
    idx.merchant >= 0 &&
    idx.txId >= 0;
  const firstRowAsData = parseCsvLine(lines[0]);
  const simpleRowsMode = !hasHeaderShape && detectSimplePayPayRowShape(firstRowAsData);
  if (!hasHeaderShape && !simpleRowsMode) {
    const missingCols = [];
    if (idx.date < 0) missingCols.push("取引日");
    if (idx.outAmount < 0) missingCols.push("出金金額（円）");
    if (idx.type < 0) missingCols.push("取引内容");
    if (idx.merchant < 0) missingCols.push("取引先");
    if (idx.txId < 0) missingCols.push("取引番号");
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
  /** @type {Array<{externalTransactionId: string, txDate: string, txSecond: string, merchantRaw: string, merchantNormalized: string, contentRaw: string, amount: number, sourceTxIds: string[]}>} */
  const paymentRows = [];
  let excludedCount = 0;

  const startRow = simpleRowsMode ? 0 : 1;
  for (let i = startRow; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    let txId = "";
    let merchantRaw = "";
    let contentRaw = "";
    let amount = null;
    let dt = null;
    if (simpleRowsMode) {
      txId = normalizeTransactionId(cols[0] ?? "");
      dt = normalizePayPayDateTime(cols[1] ?? "");
      amount = parseAmount(cols[2] ?? "");
      merchantRaw = String(cols[4] ?? cols[3] ?? "").trim();
      contentRaw = "";
    } else {
      const type = toHalfWidthComparable(cols[idx.type] ?? "");
      if (type !== "支払い") {
        excludedCount += 1;
        continue;
      }
      txId = normalizeTransactionId(cols[idx.txId] ?? "");
      merchantRaw = String(cols[idx.merchant] ?? "").trim();
      contentRaw = String(cols[idx.type] ?? "").trim();
      amount = parseAmount(cols[idx.outAmount]);
      dt = normalizePayPayDateTime(cols[idx.date] ?? "");
    }
    const merchantNormalized = toHalfWidthComparable(merchantRaw);
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
      contentRaw,
      amount,
      sourceTxIds: [txId],
    });
  }

  /** @type {Array<{externalTransactionId: string, txDate: string, txSecond: string, merchantRaw: string, merchantNormalized: string, contentRaw: string, amount: number, sourceTxIds: string[]}>} */
  let records = paymentRows;
  let aggregatedCount = 0;

  if (combineSameTimePayments || combineSmallSameDayPayments) {
    const sortedRows = [...paymentRows].sort((a, b) => a.txSecond.localeCompare(b.txSecond));
    /** @type {Array<{externalTransactionId: string, txDate: string, txSecond: string, merchantRaw: string, merchantNormalized: string, contentRaw: string, amount: number, sourceTxIds: string[]}>} */
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
 * メモは取引先（merchant）を優先し、無い場合は取引内容を使用。
 * @param {string} contentRaw
 * @param {string} merchantRaw
 * @param {boolean} combined 複数決済の合算行
 */
function buildMemo(contentRaw, merchantRaw, combined) {
  const content = String(contentRaw ?? "").trim();
  const merchant = String(merchantRaw ?? "").trim();
  const body = merchant || content || "（取引先なし）";
  const base = combined ? `${body} (複数決済を合算)` : body;
  return base.slice(0, 500);
}

function normalizeMemoForReconcile(raw) {
  return String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　\-ー‐－:：()（）「」『』[\]【】]/g, "")
    .replace(/paypay支払い/g, "")
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "")
    .trim();
}

function memosPartiallyMatch(a, b) {
  const na = normalizeMemoForReconcile(a);
  const nb = normalizeMemoForReconcile(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * レシート先行登録の取引へ PayPay 明細を後から突合して上書きする。
 * 判定: 日付±1日・金額一致・店舗名部分一致（店舗名が弱い場合は日付+金額を優先）。
 * @returns {Promise<{ rowsToUpsert: Array<any>, reconciledCount: number }>}
 */
async function reconcilePayPayRowsWithExistingReceipts(pool, userId, rows, planRecords) {
  const remaining = [];
  let reconciledCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const pr = planRecords[i];
    const merchantRaw = pr && typeof pr.merchantRaw === "string" ? pr.merchantRaw : "";
    const [candRows] = await pool.query(
      `SELECT t.id, t.memo, t.transaction_date
       FROM transactions t
       WHERE t.user_id = ?
         AND t.kind = 'expense'
         AND t.amount = ?
         AND t.external_transaction_id IS NULL
         AND t.transaction_date BETWEEN DATE_SUB(?, INTERVAL 1 DAY) AND DATE_ADD(?, INTERVAL 1 DAY)
       ORDER BY ABS(DATEDIFF(t.transaction_date, ?)) ASC, t.id DESC
       LIMIT 20`,
      [userId, row.amount, row.transactionDate, row.transactionDate, row.transactionDate],
    );
    const merchantNorm = normalizeMemoForReconcile(merchantRaw);
    const matched = Array.isArray(candRows)
      ? candRows.find((c) => {
          if (!merchantNorm) return true;
          return memosPartiallyMatch(merchantRaw, c?.memo ?? "");
        })
      : null;
    if (!matched) {
      remaining.push(row);
      continue;
    }
    await pool.query(
      `UPDATE transactions t
       SET t.transaction_date = ?,
           t.memo = ?,
           t.category_id = COALESCE(t.category_id, ?),
           t.external_transaction_id = ?,
           t.updated_at = NOW()
       WHERE t.user_id = ? AND t.id = ?`,
      [
        row.transactionDate,
        row.memo,
        row.categoryId != null && row.categoryId !== undefined ? row.categoryId : null,
        row.externalTransactionId,
        userId,
        Number(matched.id),
      ],
    );
    reconciledCount += 1;
  }
  return { rowsToUpsert: remaining, reconciledCount };
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
    memo: buildMemo(r.contentRaw, r.merchantRaw, r.sourceTxIds.length > 1),
    categoryId: /** @type {number | null} */ (null),
  }));
  await applyPayPayCategoryResolution(pool, userId, plan.records, rows, dryRun);
  let rowsForUpsert = rows;
  let reconciledCount = 0;
  if (!dryRun) {
    const rec = await reconcilePayPayRowsWithExistingReceipts(pool, userId, rows, plan.records);
    rowsForUpsert = rec.rowsToUpsert;
    reconciledCount = rec.reconciledCount;
  }
  const extIds = rowsForUpsert.map((r) => r.externalTransactionId);
  const existingIds = await fetchExistingExternalIds(pool, userId, extIds);
  const updatedByExternalIdCount = rowsForUpsert.filter((r) => existingIds.has(r.externalTransactionId)).length;
  const newCount = rowsForUpsert.length - updatedByExternalIdCount;
  const updatedCount = updatedByExternalIdCount + reconciledCount;

  if (!dryRun) {
    await bulkUpsertTransactions(pool, rowsForUpsert);
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
