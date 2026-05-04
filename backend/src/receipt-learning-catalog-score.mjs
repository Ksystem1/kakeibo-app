/**
 * 共有レシート学習カタログ（receipt_learning_catalog）のスコアリング・ヒント解決用の純粋関数。
 * B/C（汎用年月減衰・件数重み）の単体テスト用に app-core から分離。
 *
 * category_name_hint → ユーザー支出カテゴリ ID は {@link resolveSharedLearningCatalogHintToUserCategory} で解決する。
 */

import { normalizeCategoryNameKey } from "./category-utils.mjs";

export const RECEIPT_LEARNING_GENERIC_YM = "0000-00";

/** 環境変数 RECEIPT_LEARNING_SCORE_DEBUG=1|true で素点計算の内訳を console.log */
const RECEIPT_LEARNING_SCORE_DEBUG =
  process.env.RECEIPT_LEARNING_SCORE_DEBUG === "1" ||
  process.env.RECEIPT_LEARNING_SCORE_DEBUG === "true";

/**
 * 明細名・カタログ item_tokens の突合用（app-core と同一ルール）。
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeReceiptLearningToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "")
    .replace(/[()（）【】\[\]{}「」『』<>＜＞:：;；,，.。・]/g, "");
}

function debugScoreLog(payload) {
  if (!RECEIPT_LEARNING_SCORE_DEBUG) return;
  console.log("[receiptLearningCatalogScore]", JSON.stringify(payload));
}

/** C: sample_count に応じた行スコアへの乗数（1回 / 2回 / 3回以上） */
export const RECEIPT_LEARNING_SAMPLE_COUNT_WEIGHT = Object.freeze({
  /** n === 1 */
  ONE: 0.3,
  /** n === 2 */
  TWO: 0.55,
  /** n >= 3 */
  THREE_PLUS: 1.0,
});

/**
 * C: 件数によるノイズ低減（カテゴリ推測・parseHints 共通）。
 * @param {unknown} sampleCount
 * @returns {number}
 */
export function receiptLearningSampleCountWeight(sampleCount) {
  const n = Math.max(1, Math.floor(Number(sampleCount) || 0));
  if (n >= 3) return RECEIPT_LEARNING_SAMPLE_COUNT_WEIGHT.THREE_PLUS;
  if (n === 2) return RECEIPT_LEARNING_SAMPLE_COUNT_WEIGHT.TWO;
  return RECEIPT_LEARNING_SAMPLE_COUNT_WEIGHT.ONE;
}

/** B: レシートが具体年月でカタログ行が汎用（0000-00）のときに行スコアへ乗算する係数 */
export const RECEIPT_LEARNING_GENERIC_YM_DECAY_MULTIPLIER = 0.45;

/**
 * B: レシート側に具体年月があるときのみ、カタログ行が汎用なら減衰する（汎用同士は 1.0）。
 * @param {unknown} rowYm
 * @param {string} receiptYm
 * @returns {number}
 */
export function receiptLearningGenericYmRowScoreFactor(rowYm, receiptYm) {
  const row = String(rowYm ?? "").trim();
  const rec = String(receiptYm ?? "").trim();
  if (rec === RECEIPT_LEARNING_GENERIC_YM || rec === "") return 1;
  if (row !== RECEIPT_LEARNING_GENERIC_YM) return 1;
  return RECEIPT_LEARNING_GENERIC_YM_DECAY_MULTIPLIER;
}

/** parseHints 側で加重後の「有効件数」が極端に小さいときのスコア下限（チューニング用） */
export const RECEIPT_LEARNING_PARSE_HINT_WEIGHTED_SCORE_FLOOR = 0.35;

/** 共有カタログのカテゴリ素点: 具体年月が行と一致したときの加点（B の減衰とは別） */
export const RECEIPT_LEARNING_CATEGORY_SCORE_YM_MATCH_BONUS = 2;

/** カタログ行とレシート合計の差がこれ以下なら「ほぼ一致」加点 */
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_MAX_DIFF = 1;
/** ほぼ一致時の加点 */
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_BONUS = 5;

/** 差がこれ以下なら粗一致加点（ほぼ一致より緩い） */
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_MAX_DIFF = 20;
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_BONUS = 2;

/** 差がこれ以上ならペナルティ（大口ずれのノイズ抑制） */
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_MIN_DIFF = 5000;
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_PENALTY = 1;

/** 明細トークン重複 1 件あたりの素点加点係数（overlap に乗算） */
export const RECEIPT_LEARNING_CATEGORY_LINE_OVERLAP_SCORE_PER_TOKEN = 3;

/** カテゴリ推測用の共有カタログ取得件数上限 */
export const RECEIPT_LEARNING_CATEGORY_CATALOG_QUERY_LIMIT = 400;

/**
 * `category_name_hint` とユーザー支出カテゴリ名の文字列類似度しきい値（0〜1、レーベンシュタイン正規化）。
 * これ未満は部分一致に頼らずフォールバックカテゴリへ誘導する。
 */
export const RECEIPT_LEARNING_CATEGORY_HINT_SIMILARITY_THRESHOLD = 0.68;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const v0 = new Array(n + 1);
  const v1 = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) v0[j] = j;
  for (let i = 0; i < m; i += 1) {
    v1[0] = i + 1;
    for (let j = 0; j < n; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= n; j += 1) v0[j] = v1[j];
  }
  return v0[n];
}

/**
 * 正規化済み同士の簡易類似度 0〜1
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function normalizedStringSimilarity01(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const d = levenshteinDistance(a, b);
  return 1 - d / Math.max(a.length, b.length, 1);
}

/**
 * ヒントがどのカテゴリにもマッチしないときの支出フォールバック（その他系 → 一覧末尾）。
 * @param {Array<{ id: unknown, name: unknown }>} userExpenseCategories ORDER BY sort_order 済みを推奨
 * @returns {{ id: number, name: string, match: string } | null}
 */
export function pickFallbackSharedLearningExpenseCategory(userExpenseCategories) {
  const cats = Array.isArray(userExpenseCategories) ? userExpenseCategories : [];
  if (cats.length === 0) return null;
  const nk = (x) => normalizeCategoryNameKey(x);
  for (const label of ["その他（支出）", "その他", "雑費"]) {
    const want = nk(label);
    const hit = cats.find((c) => nk(c?.name ?? "") === want);
    if (hit?.id != null) {
      return { id: Number(hit.id), name: String(hit.name), match: "fallback_exact_label" };
    }
  }
  const misc = cats.find((c) => {
    const k = nk(c?.name ?? "");
    return (
      k.includes("その他") ||
      k.includes("雑費") ||
      k === "other" ||
      /^misc\b/i.test(String(c?.name ?? ""))
    );
  });
  if (misc?.id != null) {
    return { id: Number(misc.id), name: String(misc.name), match: "fallback_misc_keyword" };
  }
  const last = cats[cats.length - 1];
  return { id: Number(last.id), name: String(last.name), match: "fallback_list_tail" };
}

/**
 * 共有カタログの category_name_hint を、ユーザー支出カテゴリ一覧へマッピングする。
 * 優先度: 正規化名の完全一致 → 部分一致（長い一致を優先）→ 類似度が閾値以上 → フォールバック。
 *
 * @param {unknown} hint
 * @param {Array<{ id: unknown, name: unknown }>} userExpenseCategories
 * @param {{ similarityThreshold?: number }} [options]
 * @returns {{ id: number, name: string, match: string, similarity?: number } | null}
 */
export function resolveSharedLearningCatalogHintToUserCategory(
  hint,
  userExpenseCategories,
  options = {},
) {
  const cats = Array.isArray(userExpenseCategories) ? userExpenseCategories : [];
  if (cats.length === 0) return null;
  const threshold =
    options.similarityThreshold ?? RECEIPT_LEARNING_CATEGORY_HINT_SIMILARITY_THRESHOLD;

  const hintRaw = String(hint ?? "").trim();
  if (!hintRaw) {
    return pickFallbackSharedLearningExpenseCategory(cats);
  }

  const hintKey = normalizeCategoryNameKey(hintRaw);
  if (!hintKey) {
    return pickFallbackSharedLearningExpenseCategory(cats);
  }

  for (const c of cats) {
    const ck = normalizeCategoryNameKey(c?.name ?? "");
    if (ck === hintKey && c?.id != null) {
      return {
        id: Number(c.id),
        name: String(c.name),
        match: "exact",
        similarity: 1,
      };
    }
  }

  let bestSub = null;
  let bestOverlapRatio = -1;
  for (const c of cats) {
    const ck = normalizeCategoryNameKey(c?.name ?? "");
    if (!ck || c?.id == null) continue;
    if (ck.includes(hintKey) || hintKey.includes(ck)) {
      const overlapRatio =
        Math.min(ck.length, hintKey.length) / Math.max(ck.length, hintKey.length, 1);
      if (overlapRatio > bestOverlapRatio) {
        bestOverlapRatio = overlapRatio;
        bestSub = { id: Number(c.id), name: String(c.name) };
      }
    }
  }
  if (bestSub != null) {
    return {
      ...bestSub,
      match: "substring",
      similarity: bestOverlapRatio,
    };
  }

  let bestSim = -1;
  let bestSimCat = null;
  for (const c of cats) {
    const ck = normalizeCategoryNameKey(c?.name ?? "");
    if (!ck || c?.id == null) continue;
    const sim = normalizedStringSimilarity01(hintKey, ck);
    if (sim >= threshold && sim > bestSim) {
      bestSim = sim;
      bestSimCat = { id: Number(c.id), name: String(c.name) };
    }
  }
  if (bestSimCat != null) {
    return { ...bestSimCat, match: "similarity", similarity: bestSim };
  }

  return pickFallbackSharedLearningExpenseCategory(cats);
}

/**
 * @typedef {{
 *   receiptYm: string,
 *   receiptTotal: number | null,
 *   tokenSet: Set<string>,
 *   vendorNorm?: string | null,
 * }} ReceiptLearningCatalogScoreCtx
 * tokenSet は OCR 明細名を normalizeReceiptLearningToken 済みの集合。
 */

/**
 * 共有カタログ 1 行の素点の内訳（個人補正・カテゴリ ID 解決の前）。
 * @param {object} row DB 行（ym/year_month, sample_count, total_amount, item_tokens）
 * @param {ReceiptLearningCatalogScoreCtx} ctx
 * @returns {{
 *   finalScore: number,
 *   steps: {
 *     rawSampleBase: number,
 *     ymMatchBonus: number,
 *     amountBonus: number,
 *     amountPenalty: number,
 *     overlapCount: number,
 *     overlapBonus: number,
 *     subtotalBeforeWeights: number,
 *     sampleCount: number,
 *     sampleCountWeight: number,
 *     genericYmFactor: number,
 *     rowYm: string,
 *     rowTotalParsed: number | null,
 *     receiptTotalUsed: number | null,
 *   }
 * }}
 */
export function explainReceiptLearningCatalogRowScore(row, ctx) {
  const receiptYm = ctx.receiptYm;
  const total = ctx.receiptTotal;
  const tokenSetNow = ctx.tokenSet;

  const rowYm = String(row?.ym ?? row?.year_month ?? "");
  const rawSampleBase = Math.max(1, Number(row?.sample_count ?? 1));
  let subtotal = rawSampleBase;

  let ymMatchBonus = 0;
  if (rowYm === receiptYm && receiptYm !== RECEIPT_LEARNING_GENERIC_YM) {
    ymMatchBonus = RECEIPT_LEARNING_CATEGORY_SCORE_YM_MATCH_BONUS;
    subtotal += ymMatchBonus;
  }

  let amountBonus = 0;
  let amountPenalty = 0;
  const rowTotal = Number(row?.total_amount ?? NaN);
  const rowTotalParsed = Number.isFinite(rowTotal) && rowTotal > 0 ? Math.round(rowTotal) : null;

  if (total != null && rowTotalParsed != null) {
    const diff = Math.abs(rowTotalParsed - total);
    if (diff <= RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_MAX_DIFF) {
      amountBonus = RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_BONUS;
      subtotal += amountBonus;
    } else if (diff <= RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_MAX_DIFF) {
      amountBonus = RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_BONUS;
      subtotal += amountBonus;
    } else if (diff >= RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_MIN_DIFF) {
      amountPenalty = RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_PENALTY;
      subtotal -= amountPenalty;
    }
  }

  const rowTokensRaw = String(row?.item_tokens ?? "")
    .split("|")
    .map((x) => String(x).trim())
    .filter(Boolean);
  let overlapCount = 0;
  if (rowTokensRaw.length > 0 && tokenSetNow.size > 0) {
    for (const tk of rowTokensRaw) {
      const nk = normalizeReceiptLearningToken(tk);
      if (nk && tokenSetNow.has(nk)) overlapCount += 1;
    }
  }
  const overlapBonus =
    overlapCount >= 1 ? overlapCount * RECEIPT_LEARNING_CATEGORY_LINE_OVERLAP_SCORE_PER_TOKEN : 0;
  subtotal += overlapBonus;

  const subtotalBeforeWeights = subtotal;
  const scRow = Math.max(1, Number(row?.sample_count ?? 1));
  const sampleCountWeight = receiptLearningSampleCountWeight(scRow);
  const genericYmFactor = receiptLearningGenericYmRowScoreFactor(rowYm, receiptYm);
  const finalScore = subtotalBeforeWeights * sampleCountWeight * genericYmFactor;

  const steps = {
    rawSampleBase,
    ymMatchBonus,
    amountBonus,
    amountPenalty,
    overlapCount,
    overlapBonus,
    subtotalBeforeWeights,
    sampleCount: scRow,
    sampleCountWeight,
    genericYmFactor,
    rowYm,
    rowTotalParsed,
    receiptTotalUsed: total,
    rowItemTokensRawSample: rowTokensRaw.slice(0, 8),
  };

  debugScoreLog({
    vendorNorm: ctx.vendorNorm ?? null,
    rowSampleCount: row?.sample_count,
    steps,
    finalScore,
  });

  return { finalScore, steps };
}

/**
 * 共有カタログ 1 行の素点（個人補正の倍率適用前）。
 * 戻り値は数値のみ。カテゴリ ID / メモは caller が担当（category_name_hint の解決は app-core）。
 *
 * @param {object} row
 * @param {ReceiptLearningCatalogScoreCtx} ctx
 * @returns {number}
 */
export function scoreReceiptLearningCatalogRow(row, ctx) {
  return explainReceiptLearningCatalogRowScore(row, ctx).finalScore;
}
