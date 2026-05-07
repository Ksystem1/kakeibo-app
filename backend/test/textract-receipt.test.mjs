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

test("analyzeReceiptImageBytes: Summaryに店名型が無い場合は上部OCRから店名を補完", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "OTHER" }, LabelDetection: { Text: "TEL" }, ValueDetection: { Text: "048-283-8812" } },
      { Type: { Text: "OTHER" }, LabelDetection: { Text: "日付" }, ValueDetection: { Text: "2026/04/29" } },
    ],
    LineItemGroups: [
      {
        LineItems: [
          {
            LineItemExpenseFields: [
              {
                Type: { Text: "ITEM" },
                ValueDetection: {
                  Text: "うなぎ割烹 竹江",
                  Geometry: { BoundingBox: { Left: 0.13, Top: 0.07, Width: 0.4, Height: 0.048 } },
                },
              },
            ],
          },
          {
            LineItemExpenseFields: [
              {
                Type: { Text: "ITEM" },
                ValueDetection: {
                  Text: "TEL 048-283-8812",
                  Geometry: { BoundingBox: { Left: 0.14, Top: 0.13, Width: 0.34, Height: 0.018 } },
                },
              },
            ],
          },
        ],
      },
    ],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.summary.vendorName, "うなぎ割烹 竹江");
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

test("applyOcrDoubleTaxTotalCorrection: OCR行が細切れでも連結抽出で18120→16610", () => {
  const fragmented = ["店", "小計", "15,100", "外税", "(10%)", "1,510", "合計", "18,120"];
  const items = [
    { name: "a", amount: 9100 },
    { name: "b", amount: 150 },
    { name: "c", amount: 3250 },
    { name: "d", amount: 2000 },
    { name: "e", amount: 600 },
  ];
  assert.equal(applyOcrDoubleTaxTotalCorrection(18120, fragmented, items), 16610);
});

test("applyOcrDoubleTaxTotalCorrection: 明細合計がOCR小計と一致する税込を小計+税に揃える", () => {
  const ocr = ["小計", "15100", "外税 10%", "1510", "合計", "18120"];
  const items = [
    { name: "a", amount: 9100 },
    { name: "b", amount: 150 },
    { name: "c", amount: 3250 },
    { name: "d", amount: 2000 },
    { name: "e", amount: 600 },
  ];
  assert.equal(applyOcrDoubleTaxTotalCorrection(18120, ocr, items), 16610);
  assert.equal(applyOcrDoubleTaxTotalCorrection(16610, ocr, items), 16610);
});

test("applyOcrDoubleTaxTotalCorrection: 合計が小計誤認でもOCRに税込合計があれば小計+税へ補正", () => {
  const ocr = ["小計", "15,100", "外税 10%", "1,510", "合 計", "16,610"];
  const items = [
    { name: "鰻重", amount: 9100 },
    { name: "大盛", amount: 150 },
    { name: "鰻重(梅)", amount: 3250 },
    { name: "うな丼", amount: 2000 },
    { name: "オレンジジュース", amount: 600 },
  ];
  assert.equal(applyOcrDoubleTaxTotalCorrection(15100, ocr, items), 16610);
});

test("applyOcrDoubleTaxTotalCorrection: 合計が税額だけに誤認識されたとき小計+税に戻す", () => {
  const ocr = ["小計", "15,100", "外税 10%", "1,510", "合計", "16,610"];
  const items = [
    { name: "a", amount: 9100 },
    { name: "b", amount: 150 },
    { name: "c", amount: 3250 },
    { name: "d", amount: 2000 },
    { name: "e", amount: 600 },
  ];
  assert.equal(applyOcrDoubleTaxTotalCorrection(1510, ocr, items), 16610);
});

test("applyOcrDoubleTaxTotalCorrection: Summary ヒントと印字税込で明細なしでも矯正", () => {
  const ocr = ["小計 15,100", "外税 10%", "1,510", "合計", "16,610"];
  assert.equal(
    applyOcrDoubleTaxTotalCorrection(1510, ocr, [], { subtotalAmount: 15100, taxAmount: 1510 }),
    16610,
  );
});

test("analyzeReceiptImageBytes: Summary の TOTAL が税額だけのとき税込に置換", async () => {
  const analyze = fakeAnalyzerWithExpenseDoc({
    ExpenseIndex: 1,
    SummaryFields: [
      { Type: { Text: "SUBTOTAL" }, ValueDetection: { Text: "15100", Confidence: 99 } },
      { Type: { Text: "TAX" }, ValueDetection: { Text: "1510", Confidence: 99 } },
      { Type: { Text: "TOTAL" }, LabelDetection: { Text: "合計" }, ValueDetection: { Text: "1510", Confidence: 98 } },
    ],
    LineItemGroups: [],
  });

  const out = await analyze(Buffer.from("dummy"));
  assert.equal(out.summary.totalAmount, 16610);
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

