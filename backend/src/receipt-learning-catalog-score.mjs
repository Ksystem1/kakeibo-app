/**
 * 共有レシート学習カタログ（receipt_learning_catalog）のスコアリング・ヒント解決用の純粋関数。
 * B/C（汎用年月減衰・件数重み）の単体テスト用に app-core から分離。
 *
 * category_name_hint → ユーザー支出カテゴリ ID は {@link resolveSharedLearningCatalogHintToUserCategory} で解決する。
 */

import { normalizeCategoryNameKey } from "./category-utils.mjs";
import {
  coerceVendorNameInputToPlainString,
  normalizeVendorForMatch,
} from "./receipt-learn.mjs";

export const RECEIPT_LEARNING_GENERIC_YM = "0000-00";

/** 環境変数 RECEIPT_LEARNING_SCORE_DEBUG=1|true で素点計算の内訳を console.log */
const RECEIPT_LEARNING_SCORE_DEBUG =
  process.env.RECEIPT_LEARNING_SCORE_DEBUG === "1" ||
  process.env.RECEIPT_LEARNING_SCORE_DEBUG === "true";

/** app-core の共有学習サジェスト側ログと共用 */
export function receiptLearningCatalogScoreDebugEnabled() {
  return RECEIPT_LEARNING_SCORE_DEBUG;
}

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

/** 差がこれ以下なら粗一致加点（ほぼ一致より緩い）— 支払と明細でズレるレシート向けに広め */
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_MAX_DIFF = 120;
/** 粗一致時の加点（ほぼ一致より低め） */
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_BONUS = 2;

/** 差がこれ以上ならペナルティ（大口ずれのノイズ抑制） */
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_MIN_DIFF = 12000;
export const RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_PENALTY = 1;

/** 支払合計と明細合計の両方があるとき、カタログ total がどちらかに寄れば加点対象にするための最小乖離（これ以上離れたら別系とみなす） */
export const RECEIPT_LEARNING_AMOUNT_PAY_VS_LINES_DIVERGENCE_WARN = 80;

/** 明細トークン重複 1 件あたりの素点加点係数（overlap に乗算） */
export const RECEIPT_LEARNING_CATEGORY_LINE_OVERLAP_SCORE_PER_TOKEN = 3;

/** カテゴリ推測用の共有カタログ取得件数上限 */
export const RECEIPT_LEARNING_CATEGORY_CATALOG_QUERY_LIMIT = 400;

/**
 * `category_name_hint` とユーザー支出カテゴリ名の文字列類似度しきい値（0〜1、レーベンシュタイン正規化）。
 * これ未満は弱い類似度ルートかフォールバックを試す。
 */
export const RECEIPT_LEARNING_CATEGORY_HINT_SIMILARITY_THRESHOLD = 0.45;

/** 上記でマッチしなくても、最良候補がこの値以上なら採用（弱い類似度） */
export const RECEIPT_LEARNING_CATEGORY_HINT_SIMILARITY_WEAK_THRESHOLD = 0.28;

/**
 * 学習カタログ行の合計と、支払合計・明細合計の近い方を採用して差分（円）を得る。
 * 明細合計と支払合計が大きく違うレシートでも、片方に合えば金額加点の対象にする。
 *
 * @param {number} rowTotalParsed
 * @param {number | null} receiptPayment
 * @param {number | null} receiptLinesSum
 * @returns {{ diff: number, used: string, altDiff: number | null } | null}
 */
export function receiptCatalogAmountDiffBest(rowTotalParsed, receiptPayment, receiptLinesSum) {
  const payOk =
    receiptPayment != null && Number.isFinite(receiptPayment) && receiptPayment > 0;
  const lineOk =
    receiptLinesSum != null && Number.isFinite(receiptLinesSum) && receiptLinesSum > 0;
  const dPay = payOk ? Math.abs(rowTotalParsed - Math.round(receiptPayment)) : null;
  const dLine = lineOk ? Math.abs(rowTotalParsed - Math.round(receiptLinesSum)) : null;
  if (dPay == null && dLine == null) return null;
  if (dPay != null && dLine != null) {
    if (dPay <= dLine) return { diff: dPay, used: "payment_vs_catalog", altDiff: dLine };
    return { diff: dLine, used: "lines_vs_catalog", altDiff: dPay };
  }
  if (dPay != null) return { diff: dPay, used: "payment_vs_catalog", altDiff: null };
  return { diff: /** @type {number} */ (dLine), used: "lines_vs_catalog", altDiff: null };
}

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
 * 優先度: 正規化名の完全一致 → セグメント分割（左から最初にマッチしたセグメントを優先）→ 全体の部分一致（indexOf）
 * → 区切り除去後の部分一致 → 類似度（主閾値）→ 弱い類似度 → フォールバック。
 *
 * @param {unknown} hint
 * @param {Array<{ id: unknown, name: unknown }>} userExpenseCategories
 * @param {{ similarityThreshold?: number, similarityWeakThreshold?: number }} [options]
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
  const weakTh =
    options.similarityWeakThreshold ?? RECEIPT_LEARNING_CATEGORY_HINT_SIMILARITY_WEAK_THRESHOLD;

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

  const segmentSplit = /[・／/｜|]/;
  if (segmentSplit.test(hintRaw)) {
    const parts = hintRaw
      .split(segmentSplit)
      .map((x) => normalizeCategoryNameKey(x))
      .filter((x) => x.length >= 2);
    for (const seg of parts) {
      let bestSegCat = null;
      let bestSegR = -1;
      for (const c of cats) {
        const ck = normalizeCategoryNameKey(c?.name ?? "");
        if (!ck || c?.id == null) continue;
        if (ck === seg || ck.includes(seg) || seg.includes(ck)) {
          const r = Math.min(ck.length, seg.length) / Math.max(ck.length, seg.length, 1);
          if (r > bestSegR) {
            bestSegR = r;
            bestSegCat = { id: Number(c.id), name: String(c.name) };
          }
        }
      }
      if (bestSegCat != null) {
        return { ...bestSegCat, match: "segment", similarity: bestSegR };
      }
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

  const compact = hintKey.replace(/[・／/｜|、,，。\s]+/g, "");
  if (compact.length >= 2 && compact !== hintKey) {
    let bestCompact = null;
    let bestCompactRatio = -1;
    for (const c of cats) {
      const ck = normalizeCategoryNameKey(c?.name ?? "");
      if (!ck || ck.length < 2 || c?.id == null) continue;
      if (compact.includes(ck) || ck.includes(compact)) {
        const overlapRatio =
          Math.min(ck.length, compact.length) / Math.max(ck.length, compact.length, 1);
        if (overlapRatio > bestCompactRatio) {
          bestCompactRatio = overlapRatio;
          bestCompact = { id: Number(c.id), name: String(c.name) };
        }
      }
    }
    if (bestCompact != null) {
      return {
        ...bestCompact,
        match: "substring_compact",
        similarity: bestCompactRatio,
      };
    }
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

  let weakBest = -1;
  let weakCat = null;
  for (const c of cats) {
    const ck = normalizeCategoryNameKey(c?.name ?? "");
    if (!ck || c?.id == null) continue;
    const sim = normalizedStringSimilarity01(hintKey, ck);
    if (sim >= weakTh && sim > weakBest) {
      weakBest = sim;
      weakCat = { id: Number(c.id), name: String(c.name) };
    }
  }
  if (weakCat != null) {
    return { ...weakCat, match: "similarity_weak", similarity: weakBest };
  }

  return pickFallbackSharedLearningExpenseCategory(cats);
}

/**
 * @typedef {{
 *   receiptYm: string,
 *   receiptTotal: number | null,
 *   receiptTotalLinesSum?: number | null,
 *   tokenSet: Set<string>,
 *   vendorNorm?: string | null,
 *   catalogCategoryHintDebug?: {
 *     hintRaw: string,
 *     mappedCategoryId: number,
 *     mappedCategoryName: string,
 *     matchKind: string,
 *     similarity?: number,
 *   } | null,
 * }} ReceiptLearningCatalogScoreCtx
 * tokenSet は OCR 明細名を normalizeReceiptLearningToken 済みの集合。
 * receiptTotalLinesSum は明細金額の合算（支払合計と乖離する場合のスコア用）。
 * catalogCategoryHintDebug は suggest 側で category_name_hint → ユーザー category 解決後に付与（デバッグ用）。
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
 *     receiptTotalLinesSum: number | null,
 *     amountDiffBest: number | null,
 *     amountDiffPayment: number | null,
 *     amountDiffLines: number | null,
 *     amountDiffSource: string | null,
 *     amountBonusFrom: 'payment' | 'lines' | 'both' | null,
 *     payVsLinesGap: number | null,
 *     categoryHintResolve: {
 *       hintRaw: string,
 *       mappedCategoryId: number,
 *       mappedCategoryName: string,
 *       matchKind: string,
 *       similarity?: number,
 *     } | null,
 *     amountScoringSkippedReason: string | null,
 *     payLineMismatchNote: string | null,
 *   }
 * }}
 */
function amountBonusPenaltyFromDiff(d) {
  if (d == null || !Number.isFinite(d)) return { bonus: 0, penalty: 0 };
  if (d <= RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_MAX_DIFF) {
    return { bonus: RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_BONUS, penalty: 0 };
  }
  if (d <= RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_MAX_DIFF) {
    return { bonus: RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_ROUGH_BONUS, penalty: 0 };
  }
  if (d >= RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_MIN_DIFF) {
    return { bonus: 0, penalty: RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_PENALTY };
  }
  return { bonus: 0, penalty: 0 };
}

export function explainReceiptLearningCatalogRowScore(row, ctx) {
  const receiptYm = ctx.receiptYm;
  const total = ctx.receiptTotal;
  const linesSum =
    ctx.receiptTotalLinesSum != null && Number.isFinite(Number(ctx.receiptTotalLinesSum))
      ? Math.round(Number(ctx.receiptTotalLinesSum))
      : null;
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

  let amountDiffBest = null;
  /** @type {string | null} */
  let amountDiffSource = null;
  /** @type {'payment' | 'lines' | 'both' | null} */
  let amountBonusFrom = null;
  /** @type {number | null} */
  let amountDiffPayment = null;
  /** @type {number | null} */
  let amountDiffLines = null;
  let payVsLinesGap = null;
  if (
    total != null &&
    Number.isFinite(total) &&
    total > 0 &&
    linesSum != null &&
    linesSum > 0
  ) {
    payVsLinesGap = Math.abs(Math.round(total) - linesSum);
  }

  const payOkForGate = total != null && Number.isFinite(total) && total > 0;
  const lineOkForGate = linesSum != null && linesSum > 0;
  /** @type {string | null} */
  let amountScoringSkippedReason = null;
  if (rowTotalParsed == null) {
    amountScoringSkippedReason = "catalog_row_total_missing_or_invalid";
  } else if (!payOkForGate && !lineOkForGate) {
    amountScoringSkippedReason = "receipt_payment_and_lines_sum_unavailable";
  }

  if (rowTotalParsed != null) {
    const payOk = payOkForGate;
    const lineOk = lineOkForGate;
    if (payOk || lineOk) {
      const best = receiptCatalogAmountDiffBest(
        rowTotalParsed,
        payOk ? total : null,
        lineOk ? linesSum : null,
      );
      if (best != null) {
        amountDiffBest = best.diff;
        amountDiffSource = best.used;
      }
      if (payOk) {
        amountDiffPayment = Math.abs(rowTotalParsed - Math.round(Number(total)));
      }
      if (lineOk) {
        amountDiffLines = Math.abs(rowTotalParsed - Math.round(Number(linesSum)));
      }
      const tp = amountBonusPenaltyFromDiff(amountDiffPayment);
      const tl = amountBonusPenaltyFromDiff(amountDiffLines);
      if (amountDiffPayment != null && amountDiffLines != null) {
        amountBonus = Math.max(tp.bonus, tl.bonus);
        if (amountBonus > 0) {
          if (tp.bonus === tl.bonus) amountBonusFrom = "both";
          else if (tp.bonus > tl.bonus) amountBonusFrom = "payment";
          else amountBonusFrom = "lines";
        }
        amountPenalty =
          tp.penalty > 0 && tl.penalty > 0 ? RECEIPT_LEARNING_CATEGORY_AMOUNT_FAR_PENALTY : 0;
      } else if (amountDiffPayment != null) {
        amountBonus = tp.bonus;
        amountPenalty = tp.penalty;
        if (tp.bonus > 0) amountBonusFrom = "payment";
      } else if (amountDiffLines != null) {
        amountBonus = tl.bonus;
        amountPenalty = tl.penalty;
        if (tl.bonus > 0) amountBonusFrom = "lines";
      }
      subtotal += amountBonus;
      subtotal -= amountPenalty;
    }
  }

  subtotal = Math.max(0.25, subtotal);

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

  const payLineMismatch =
    payVsLinesGap != null && payVsLinesGap >= RECEIPT_LEARNING_AMOUNT_PAY_VS_LINES_DIVERGENCE_WARN;
  const payLineMismatchNote = payLineMismatch
    ? "pay_vs_lines_gap_is_informational_only_does_not_clear_hints_or_overlap"
    : null;

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
    receiptTotalLinesSum: linesSum,
    amountDiffBest,
    amountDiffPayment,
    amountDiffLines,
    amountDiffSource,
    amountBonusFrom,
    payVsLinesGap,
    payLineMismatch,
    payLineMismatchNote,
    amountScoringSkippedReason,
    rowItemTokensRawSample: rowTokensRaw.slice(0, 8),
    categoryHintResolve: ctx.catalogCategoryHintDebug ?? null,
  };

  const catDbg = ctx.catalogCategoryHintDebug;
  debugScoreLog({
    vendorNorm: ctx.vendorNorm ?? null,
    categoryResolution:
      catDbg == null
        ? null
        : {
            hintRaw: catDbg.hintRaw,
            mappedCategoryId: catDbg.mappedCategoryId,
            mappedCategoryName: catDbg.mappedCategoryName,
            matchKind: catDbg.matchKind,
            similarity: catDbg.similarity,
          },
    amountGate: {
      rowTotalParsed,
      receiptPaymentTotal: total,
      receiptLinesSum: linesSum,
      payOk: payOkForGate,
      lineOk: lineOkForGate,
      payVsLinesGap,
      payLineMismatch,
      payLineMismatchNote,
      amountScoringSkippedReason,
      ymMatchApplied: ymMatchBonus > 0,
      receiptYm,
      rowYmCatalog: rowYm,
    },
    rowSampleCount: row?.sample_count,
    rowYm,
    rowTotalFromDb: row?.total_amount,
    steps,
    finalScore,
    payLineMismatch,
    warnVeryLowScore: finalScore < 0.15,
    warnSubtotalBeforeWeights: subtotalBeforeWeights < 1,
    skipOrWeakHints: {
      tokenSetEmpty: tokenSetNow.size === 0,
      catalogItemTokensEmpty: rowTokensRaw.length === 0,
      overlapZeroWithNonEmptyTokens:
        overlapCount === 0 && rowTokensRaw.length > 0 && tokenSetNow.size > 0,
    },
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

/**
 * レシート取込のメモ欄用。オブジェクトを `String()` だけすると `[object Object]` になるため、
 * 型に応じて `name` 等を辿る（詳細は {@link coerceVendorNameInputToPlainString}）。
 * 値は `normalizeVendorForMatch` 済みキー（DB の vendor_norm と同系）。プレフィックスは付けない。
 *
 * @param {unknown} vendorNorm 文字列または店名を含むオブジェクト
 * @returns {string} 正規化キーが 2 文字未満なら空
 */
export function formatReceiptSuggestedMemoFromVendorNorm(vendorNorm) {
  let memoText = "";
  if (vendorNorm == null || vendorNorm === "") return "";
  if (typeof vendorNorm === "object") {
    memoText = coerceVendorNameInputToPlainString(vendorNorm);
  } else {
    memoText = String(vendorNorm).trim();
  }
  const norm = normalizeVendorForMatch(memoText);
  if (norm.length < 2) return "";
  return norm.slice(0, 500);
}
