/**
 * 共有レシート学習カタログ（receipt_learning_catalog）のスコアリング用定数と純粋関数。
 * B/C（汎用年月減衰・件数重み）の単体テスト用に app-core から分離。
 *
 * カテゴリ ID の決定は行わない。DB 行の category_name_hint をユーザー家計簿のカテゴリへ
 * 紐づける処理は app-core の suggestExpenseCategoryFromSharedLearningCatalog 側で行う。
 */

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
