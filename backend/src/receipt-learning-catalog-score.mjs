/**
 * 共有レシート学習カタログ（receipt_learning_catalog）のスコアリング用定数と純粋関数。
 * B/C（汎用年月減衰・件数重み）の単体テスト用に app-core から分離。
 */

export const RECEIPT_LEARNING_GENERIC_YM = "0000-00";

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
 * 共有カタログ 1 行の素点（個人補正の倍率適用前）。
 * @param {object} row DB 行（ym/year_month, sample_count, total_amount, item_tokens）
 * @param {{ receiptYm: string, receiptTotal: number | null, tokenSet: Set<string> }} ctx
 * @returns {number}
 */
export function scoreReceiptLearningCatalogRow(row, ctx) {
  const receiptYm = ctx.receiptYm;
  const total = ctx.receiptTotal;
  const tokenSetNow = ctx.tokenSet;

  const rowYm = String(row?.ym ?? row?.year_month ?? "");
  let score = Math.max(1, Number(row?.sample_count ?? 1));
  if (rowYm === receiptYm && receiptYm !== RECEIPT_LEARNING_GENERIC_YM) {
    score += RECEIPT_LEARNING_CATEGORY_SCORE_YM_MATCH_BONUS;
  }
  const rowTotal = Number(row?.total_amount ?? NaN);
  if (total != null && Number.isFinite(rowTotal) && rowTotal > 0) {
    const diff = Math.abs(rowTotal - total);
    if (diff <= RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_MAX_DIFF) {
      score += RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_BONUS;
    } else if (diff <= RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_MAX_DIFF) {
      score += RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_BONUS;
    } else if (diff >= RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_MIN_DIFF) {
      score -= RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_PENALTY;
    }
  }
  const rowTokens = String(row?.item_tokens ?? "")
    .split("|")
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (rowTokens.length > 0 && tokenSetNow.size > 0) {
    let overlap = 0;
    for (const tk of rowTokens) {
      if (tokenSetNow.has(tk)) overlap += 1;
    }
    if (overlap >= 1) {
      score += overlap * RECEIPT_LEARNING_CATEGORY_LINE_OVERLAP_SCORE_PER_TOKEN;
    }
  }
  const scRow = Math.max(1, Number(row?.sample_count ?? 1));
  score *= receiptLearningSampleCountWeight(scRow);
  score *= receiptLearningGenericYmRowScoreFactor(rowYm, receiptYm);
  return score;
}
