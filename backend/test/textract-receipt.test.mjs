import test from "node:test";
import assert from "node:assert/strict";
import { applyOcrDoubleTaxTotalCorrection, createReceiptAnalyzer } from "../src/textract-receipt.mjs";

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

test("analyzeReceiptImageBytes: 税額ラベルの候補は合計より優先しない", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "（内消費税等10%）" }, ValueDetection: { Text: "1510", Confidence: 99 } },
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "16610", Confidence: 95 } },
    ],
    LineItemGroups: [],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.summary.totalAmount, 16610);
});

test("analyzeReceiptImageBytes: 小計+税を二重に足した誤合計を小計+税へ矯正", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "SUBTOTAL" }, ValueDetection: { Text: "15100", Confidence: 99 } },
      { Type: { Text: "TAX" }, ValueDetection: { Text: "1510", Confidence: 99 } },
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "18120", Confidence: 98 } },
    ],
    LineItemGroups: [],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.summary.totalAmount, 16610);
});

test("analyzeReceiptImageBytes: Summaryに小計型が無くてもOCR行から二重税を矯正", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "18120", Confidence: 98 } },
    ],
    LineItemGroups: [
      {
        LineItems: [
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "小計" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "15100" } },
            ],
          },
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "外税 10%" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "1510" } },
            ],
          },
        ],
      },
    ],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.summary.totalAmount, 16610);
});

test("analyzeReceiptImageBytes: 記号のみの同一金額の重複明細を除く", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "9100", Confidence: 98 } },
    ],
    LineItemGroups: [
      {
        LineItems: [
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "()" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "9100" } },
            ],
          },
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "()" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "9100" } },
            ],
          },
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "()" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "9100" } },
            ],
          },
        ],
      },
    ],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].amount, 9100);
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

test("applyOcrDoubleTaxTotalCorrection: ハイブリッド後の誤合計を OCR 小計・税で矯正", () => {
  const ocrLines = ["小計", "15100", "外税 10%", "1510", "合計", "18120"];
  assert.equal(applyOcrDoubleTaxTotalCorrection(18120, ocrLines), 16610);
  assert.equal(applyOcrDoubleTaxTotalCorrection(16610, ocrLines), 16610);
});

test("applyOcrDoubleTaxTotalCorrection: 小計ブロックが無くても正税込+税の誤加算を矯正", () => {
  const ocr = ["税率10%対象額", "16610", "（内消費税等10%）", "1510", "合計", "18120"];
  assert.equal(applyOcrDoubleTaxTotalCorrection(18120, ocr), 16610);
});

test("analyzeReceiptImageBytes: 小計・合計・支払行を明細から除外し合算を抑える", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "16610", Confidence: 98 } },
    ],
    LineItemGroups: [
      {
        LineItems: [
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "品A" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "9100" } },
            ],
          },
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "小計" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "15100" } },
            ],
          },
          {
            LineItemExpenseFields: [
              { Type: { Text: "ITEM" }, ValueDetection: { Text: "J-Mupsクレジット" } },
              { Type: { Text: "PRICE" }, ValueDetection: { Text: "16610" } },
            ],
          },
        ],
      },
    ],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].amount, 9100);
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

