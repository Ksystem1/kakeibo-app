import test from "node:test";
import assert from "node:assert/strict";
import { createReceiptAnalyzer } from "../src/textract-receipt.mjs";

function fakeAnalyzerWithExpenseDoc(doc) {
  return createReceiptAnalyzer({
    useS3Mode: false,
    makeClient: () => ({
      send: async () => ({ ExpenseDocuments: [doc] }),
    }),
  });
}

test("analyzeReceiptImageBytes: subtotal+tax に整合する合計候補を優先", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "SUBTOTAL" }, ValueDetection: { Text: "1200", Confidence: 99 } },
      { Type: { Text: "TAX" }, ValueDetection: { Text: "120", Confidence: 99 } },
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "12000", Confidence: 99 } },
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "お支払金額" }, ValueDetection: { Text: "1320", Confidence: 96 } },
    ],
    LineItemGroups: [],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.summary.totalAmount, 1320);
});

test("analyzeReceiptImageBytes: 年なし日付(M/D)を日付ラベル付きで補完", async () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1);
  const dd = String(Math.max(1, now.getDate() - 1));
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "DATE" }, LabelDetection: { Text: "取引日" }, ValueDetection: { Text: `${mm}/${dd}`, Confidence: 95 } },
    ],
    LineItemGroups: [],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.match(String(out.summary.date ?? ""), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(String(out.summary.date).endsWith(`-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`));
});

test("analyzeReceiptImageBytes: 合計が明細と大きく乖離する場合はOCR行候補で補正", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "9800", Confidence: 97 } },
    ],
    LineItemGroups: [
      {
        LineItems: [
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "パン" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "600", Confidence: 90 } },
            ],
          },
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "牛乳" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "380", Confidence: 90 } },
            ],
          },
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "お支払合計 980" } },
            ],
          },
        ],
      },
    ],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.summary.totalAmount, 980);
});

