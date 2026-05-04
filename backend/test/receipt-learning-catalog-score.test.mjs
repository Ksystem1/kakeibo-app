import test from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_BONUS,
  RECEIPT_LEARNING_GENERIC_YM,
  explainReceiptLearningCatalogRowScore,
  formatReceiptSuggestedMemoFromVendorNorm,
  normalizeReceiptLearningToken,
  pickFallbackSharedLearningExpenseCategory,
  receiptCatalogAmountDiffBest,
  receiptLearningGenericYmRowScoreFactor,
  receiptLearningSampleCountWeight,
  resolveSharedLearningCatalogHintToUserCategory,
  scoreReceiptLearningCatalogRow,
} from "../src/receipt-learning-catalog-score.mjs";
import {
  coerceVendorNameInputToPlainString,
  normalizeVendorForMatch,
} from "../src/receipt-learn.mjs";

test("coerceVendorNameInputToPlainString: オブジェクトを店名字列へ", () => {
  assert.equal(coerceVendorNameInputToPlainString({ name: "テスト店" }), "テスト店");
  assert.equal(coerceVendorNameInputToPlainString({ vendorNorm: { name: "ネスト" } }), "ネスト");
  assert.equal(normalizeVendorForMatch({ storeName: "うなぎ割烹 竹江" }), "うなぎ割烹竹江");
});

test("formatReceiptSuggestedMemoFromVendorNorm: 今回は、+ vendor_norm（オブジェクトも展開）", () => {
  assert.equal(
    formatReceiptSuggestedMemoFromVendorNorm("うなぎ割烹竹江"),
    "今回は、うなぎ割烹竹江",
  );
  assert.equal(
    formatReceiptSuggestedMemoFromVendorNorm({ name: "うなぎ割烹 竹江" }),
    "今回は、うなぎ割烹竹江",
  );
  assert.equal(formatReceiptSuggestedMemoFromVendorNorm(""), "");
  assert.equal(formatReceiptSuggestedMemoFromVendorNorm("x"), "");
});

test("receiptLearningSampleCountWeight: 1 / 2 / 3+", () => {
  assert.equal(receiptLearningSampleCountWeight(1), 0.3);
  assert.equal(receiptLearningSampleCountWeight(2), 0.55);
  assert.equal(receiptLearningSampleCountWeight(3), 1.0);
  assert.equal(receiptLearningSampleCountWeight(99), 1.0);
});

test("receiptLearningGenericYmRowScoreFactor: 具体レシート × 汎用行 → 減衰", () => {
  assert.equal(
    receiptLearningGenericYmRowScoreFactor(RECEIPT_LEARNING_GENERIC_YM, "2026-03"),
    0.45,
  );
  assert.equal(receiptLearningGenericYmRowScoreFactor("2026-03", "2026-03"), 1);
  assert.equal(
    receiptLearningGenericYmRowScoreFactor(RECEIPT_LEARNING_GENERIC_YM, RECEIPT_LEARNING_GENERIC_YM),
    1,
  );
});

test("scoreReceiptLearningCatalogRow: 年月一致・金額一致・トークン重複・件数3", () => {
  const row = {
    ym: "2026-03",
    sample_count: 3,
    total_amount: 1000,
    item_tokens: "おにぎり|お茶",
  };
  const out = scoreReceiptLearningCatalogRow(row, {
    receiptYm: "2026-03",
    receiptTotal: 1000,
    tokenSet: new Set(["おにぎり"]),
  });
  assert.equal(out, 13);
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-03",
    receiptTotal: 1000,
    tokenSet: new Set(["おにぎり"]),
  });
  assert.equal(ex.finalScore, 13);
  assert.equal(ex.steps.overlapCount, 1);
});

test("scoreReceiptLearningCatalogRow: 汎用行は具体年月レシートで減衰", () => {
  const row = {
    ym: RECEIPT_LEARNING_GENERIC_YM,
    sample_count: 10,
    total_amount: 500,
    item_tokens: "",
  };
  const out = scoreReceiptLearningCatalogRow(row, {
    receiptYm: "2026-01",
    receiptTotal: 500,
    tokenSet: new Set(),
  });
  assert.equal(out, 6.75);
});

/**
 * 問題パターン再現用モック（カテゴリ ID は素点関数の外で hint→ユーザー categories に解決される）
 */
test("パターン: レシート合計なし → 金額一致ブロックがスキップされ overlap のみ頼り", () => {
  const row = {
    ym: "2026-05",
    sample_count: 2,
    total_amount: 980,
    item_tokens: "牛乳|パン",
  };
  const tokenSet = new Set(["牛乳", "パン"].map((x) => normalizeReceiptLearningToken(x)));
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-05",
    receiptTotal: null,
    tokenSet,
  });
  assert.equal(ex.steps.amountBonus, 0);
  assert.equal(ex.steps.overlapCount, 2);
  assert.ok(ex.finalScore > 0);
});

test("パターン: 金額が大きくずれる → 近接ボーナスなし（極端ならペナルティ）", () => {
  const rowNear = {
    ym: "2026-05",
    sample_count: 5,
    total_amount: 1000,
    item_tokens: "",
  };
  const e1 = explainReceiptLearningCatalogRowScore(rowNear, {
    receiptYm: "2026-05",
    receiptTotal: 1200,
    tokenSet: new Set(),
  });
  assert.equal(e1.steps.amountBonus, 0);
  assert.equal(e1.steps.amountPenalty, 0);

  const rowFar = { ...rowNear, total_amount: 12501 };
  const e2 = explainReceiptLearningCatalogRowScore(rowFar, {
    receiptYm: "2026-05",
    receiptTotal: 500,
    tokenSet: new Set(),
  });
  assert.equal(e2.steps.amountPenalty, 1);
});

test("パターン: 支払い合計と明細合計が違うが、明細合計がカタログに一致すれば金額加点", () => {
  const row = {
    ym: "2026-05",
    sample_count: 3,
    total_amount: 15100,
    item_tokens: "",
  };
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-05",
    receiptTotal: 16610,
    receiptTotalLinesSum: 15100,
    tokenSet: new Set(),
  });
  assert.equal(ex.steps.amountBonus, RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_BONUS);
  assert.equal(ex.steps.amountBonusFrom, "lines");
  assert.equal(ex.steps.amountPenalty, 0);
});

test("パターン: 支払・明細の両方がカタログから極端に離れるときのみ遠方ペナルティ", () => {
  const row = {
    ym: "2026-05",
    sample_count: 3,
    total_amount: 12501,
    item_tokens: "",
  };
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-05",
    receiptTotal: 500,
    receiptTotalLinesSum: 500,
    tokenSet: new Set(),
  });
  assert.equal(ex.steps.amountPenalty, 1);
});

test("パターン: 片方だけ極端ずれでも、もう片方が一致すれば遠方ペナルティを付けない", () => {
  const row = {
    ym: "2026-05",
    sample_count: 3,
    total_amount: 1000,
    item_tokens: "",
  };
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-05",
    receiptTotal: 15000,
    receiptTotalLinesSum: 1000,
    tokenSet: new Set(),
  });
  assert.equal(ex.steps.amountBonus, RECEIPT_LEARNING_CATEGORY_AMOUNT_NEAR_EXACT_BONUS);
  assert.equal(ex.steps.amountBonusFrom, "lines");
  assert.equal(ex.steps.amountPenalty, 0);
});

test("パターン: 明細トークン空（OCR 明細なし）→ overlap 0 で素点は件数・年月・金額のみ", () => {
  const row = {
    ym: "2026-04",
    sample_count: 1,
    total_amount: 500,
    item_tokens: "ウーロン茶|おにぎり",
  };
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-04",
    receiptTotal: 500,
    tokenSet: new Set(),
  });
  assert.equal(ex.steps.overlapCount, 0);
  assert.equal(ex.steps.overlapBonus, 0);
  assert.ok(ex.finalScore > 0);
});

test("パターン: カタログ item_tokens と OCR 明細の表記ゆれ → normalize で突合", () => {
  const row = {
    ym: "2026-04",
    sample_count: 3,
    total_amount: 300,
    item_tokens: "ウーロン茶",
  };
  const rawLineName = "ウーロン　茶"; // 空白あり（normalize で一致）
  const tokenSet = new Set([normalizeReceiptLearningToken(rawLineName)]);
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-04",
    receiptTotal: 300,
    tokenSet,
  });
  assert.equal(ex.steps.overlapCount, 1);
});

test("resolveSharedLearningCatalogHintToUserCategory: 完全一致", () => {
  const cats = [
    { id: 1, name: "食費" },
    { id: 2, name: "医療・健康" },
  ];
  const r = resolveSharedLearningCatalogHintToUserCategory("食費", cats, {});
  assert.equal(r.id, 1);
  assert.equal(r.match, "exact");
});

test("resolveSharedLearningCatalogHintToUserCategory: 部分一致（学習ヒントが短い）", () => {
  const cats = [{ id: 10, name: "食費・日用品" }];
  const r = resolveSharedLearningCatalogHintToUserCategory("食費", cats, {});
  assert.equal(r.id, 10);
  assert.equal(r.match, "substring");
});

test("resolveSharedLearningCatalogHintToUserCategory: 複合ヒントは左セグメントを優先（食費・日用品→食費）", () => {
  const cats = [
    { id: 1, name: "食費" },
    { id: 2, name: "日用品" },
  ];
  const r = resolveSharedLearningCatalogHintToUserCategory("食費・日用品", cats, {});
  assert.equal(r.id, 1);
  assert.equal(r.match, "segment");
});

test("resolveSharedLearningCatalogHintToUserCategory: セグメント（全体では部分一致しないとき区切りで照合）", () => {
  const cats = [
    { id: 1, name: "食費（固定）" },
    { id: 2, name: "日用品（消耗）" },
  ];
  const r = resolveSharedLearningCatalogHintToUserCategory("食費・日用品", cats, {});
  assert.ok(r.id === 1 || r.id === 2);
  assert.equal(r.match, "segment");
});

test("receiptCatalogAmountDiffBest: 支払と明細が離れていてもカタログに近い方を採用", () => {
  const b = receiptCatalogAmountDiffBest(1000, 5000, 1000);
  assert.equal(b.diff, 0);
  assert.equal(b.used, "lines_vs_catalog");
});

test("resolveSharedLearningCatalogHintToUserCategory: 類似度（部分一致が無いとき編集距離）", () => {
  const cats = [{ id: 99, name: "カテゴリabcd" }];
  const r = resolveSharedLearningCatalogHintToUserCategory("カテゴリabce", cats, {});
  assert.equal(r.id, 99);
  assert.equal(r.match, "similarity");
  assert.ok((r.similarity ?? 0) >= 0.45);
});

test("resolveSharedLearningCatalogHintToUserCategory: 合致なし → その他系フォールバック", () => {
  const cats = [
    { id: 1, name: "食費" },
    { id: 2, name: "その他（支出）" },
  ];
  const r = resolveSharedLearningCatalogHintToUserCategory("存在しないカテゴリ名ZZZ", cats, {
    similarityThreshold: 0.99,
  });
  assert.equal(r.id, 2);
  assert.ok(r.match.startsWith("fallback_"));
});

test("pickFallbackSharedLearningExpenseCategory: 末尾カテゴリ", () => {
  const r = pickFallbackSharedLearningExpenseCategory([{ id: 7, name: "A" }]);
  assert.equal(r.id, 7);
  assert.equal(r.match, "fallback_list_tail");
});

test("explainReceiptLearningCatalogRowScore は category_name_hint を見ない（caller がカテゴリ解決）", () => {
  const row = {
    ym: "2026-01",
    sample_count: 10,
    total_amount: 100,
    item_tokens: "",
    category_name_hint: "存在しないカテゴリ名",
  };
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-01",
    receiptTotal: 100,
    tokenSet: new Set(),
  });
  assert.ok(Number.isFinite(ex.finalScore));
  assert.equal("categoryId" in ex.steps, false);
});

test("explainReceiptLearningCatalogRowScore: categoryHintResolve にヒント解決を載せられる", () => {
  const row = {
    ym: "2026-03",
    sample_count: 3,
    total_amount: 15100,
    item_tokens: "うなぎ|オレンジ",
  };
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-03",
    receiptTotal: 16610,
    receiptTotalLinesSum: 15100,
    tokenSet: new Set(),
    catalogCategoryHintDebug: {
      hintRaw: "食費・日用品",
      mappedCategoryId: 42,
      mappedCategoryName: "食費",
      matchKind: "segment",
      similarity: 1,
    },
  });
  assert.equal(ex.steps.categoryHintResolve?.mappedCategoryId, 42);
  assert.equal(ex.steps.categoryHintResolve?.matchKind, "segment");
  assert.equal(ex.steps.payLineMismatch, true);
  assert.ok(String(ex.steps.payLineMismatchNote ?? "").includes("informational_only"));
});

test("explainReceiptLearningCatalogRowScore: レシート金額が無いとき amountScoringSkippedReason", () => {
  const row = { ym: "2026-03", sample_count: 2, total_amount: 1000, item_tokens: "" };
  const ex = explainReceiptLearningCatalogRowScore(row, {
    receiptYm: "2026-03",
    receiptTotal: null,
    receiptTotalLinesSum: null,
    tokenSet: new Set(),
  });
  assert.equal(ex.steps.amountScoringSkippedReason, "receipt_payment_and_lines_sum_unavailable");
});
