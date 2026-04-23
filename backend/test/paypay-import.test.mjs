import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPayPayImportPlan,
  executePayPayCsvImport,
} from "../src/paypay-import.mjs";

const SAMPLE_HEADER =
  "取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号";

test("buildPayPayImportPlan: 支払いのみ対象・取引番号を文字列保持", () => {
  const csv = [
    SAMPLE_HEADER,
    '2026/04/22 20:06:10,-,"10,000",-,-,-,-,チャージ,PayPay,残高,-,-,02251346003810353174',
    '2026/04/22 20:06:10,"2,112",-,-,-,-,-,支払い, セブン-イレブン  ,PayPay残高,-,-,04962494283168276483',
  ].join("\n");
  const plan = buildPayPayImportPlan(csv, { combineSameTimePayments: false });
  assert.equal(plan.ok, true);
  assert.equal(plan.records.length, 1);
  assert.equal(plan.counts.paymentRows, 1);
  assert.equal(plan.counts.excludedCount, 1);
  assert.equal(plan.records[0].externalTransactionId, "04962494283168276483");
});

test("buildPayPayImportPlan: 合算ONは同秒かつ同取引先のみ合算", () => {
  const csv = [
    SAMPLE_HEADER,
    "2026/04/22 12:00:00,100,-,-,-,-,-,支払い,ＡＢＣ商店,PayPay残高,-,-,tx-1",
    "2026/04/22 12:00:00,250,-,-,-,-,-,支払い,ABC商店,PayPay残高,-,-,tx-2",
    "2026/04/22 12:00:00,333,-,-,-,-,-,支払い,別店舗,PayPay残高,-,-,tx-3",
  ].join("\n");
  const plan = buildPayPayImportPlan(csv, { combineSameTimePayments: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.records.length, 2);
  assert.equal(plan.counts.aggregatedCount, 1);
  const merged = plan.records.find((r) => r.merchantNormalized === "ABC商店");
  assert.ok(merged);
  assert.equal(merged.amount, 350);
});

test("executePayPayCsvImport: 既存IDは更新カウントされる", async () => {
  const calls = [];
  const fakePool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (String(sql).includes("SELECT external_transaction_id FROM transactions")) {
        return [[{ external_transaction_id: "existing-1" }]];
      }
      return [[{ affectedRows: 1 }]];
    },
  };
  const csv = [
    SAMPLE_HEADER,
    "2026/04/22 10:00:00,100,-,-,-,-,-,支払い,店舗A,PayPay残高,-,-,existing-1",
    "2026/04/22 10:01:00,200,-,-,-,-,-,支払い,店舗B,PayPay残高,-,-,new-1",
  ].join("\n");

  const r = await executePayPayCsvImport(fakePool, {
    userId: 10,
    familyId: 1,
    csvText: csv,
    combineSameTimePayments: false,
    dryRun: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.counts.newCount, 1);
  assert.equal(r.counts.updatedCount, 1);
  assert.ok(calls.some((c) => String(c.sql).includes("ON DUPLICATE KEY UPDATE")));
});

test("executePayPayCsvImport: メモは店舗名のみ（時刻・取引番号の文字列は含めない）", async () => {
  const calls = [];
  const fakePool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (String(sql).includes("SELECT external_transaction_id")) {
        return [[]];
      }
      return [[{ affectedRows: 1 }]];
    },
  };
  const csv = [
    SAMPLE_HEADER,
    "2026/04/22 10:00:00,100,-,-,-,-,-,支払い,七福亭,PayPay残高,-,-,memo-fmt-1",
  ].join("\n");
  await executePayPayCsvImport(fakePool, {
    userId: 1,
    familyId: 1,
    csvText: csv,
    dryRun: false,
  });
  const insert = calls.find((c) => String(c.sql).includes("INSERT INTO transactions"));
  assert.ok(insert);
  const params = insert.params;
  const memo = params.find(
    (x) => typeof x === "string" && x.startsWith("PayPay支払い:") && x.includes("七福亭"),
  );
  assert.ok(memo, `memo を params から検出: ${JSON.stringify(params)}`);
  assert.equal(memo.includes("時刻:"), false);
  assert.equal(memo.includes("取引番号:"), false);
  assert.equal(memo.includes("memo-fmt-1"), false);
});

