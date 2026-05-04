import test from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_LEARNING_GENERIC_YM,
  explainReceiptLearningCatalogRowScore,
  normalizeReceiptLearningToken,
  receiptLearningGenericYmRowScoreFactor,
  receiptLearningSampleCountWeight,
  scoreReceiptLearningCatalogRow,
} from "../src/receipt-learning-catalog-score.mjs";

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

  const rowFar = { ...rowNear, total_amount: 12000 };
  const e2 = explainReceiptLearningCatalogRowScore(rowFar, {
    receiptYm: "2026-05",
    receiptTotal: 500,
    tokenSet: new Set(),
  });
  assert.equal(e2.steps.amountPenalty, 1);
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
