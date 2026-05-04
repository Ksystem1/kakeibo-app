import test from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_LEARNING_GENERIC_YM,
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
  // 3 +2(ym) +5(金額) +1*3(重複) = 13 → 件数・年月因子とも 1
  assert.equal(out, 13);
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
  // 10 +5(金額) = 15 → ×0.45(汎用行減衰) = 6.75
  assert.equal(out, 6.75);
});
