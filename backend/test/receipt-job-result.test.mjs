import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAsyncReceiptJobResultFromHttpBody,
  buildReceiptJobErrorData,
  receiptJobResultDataForMysqlBinding,
} from "../src/receipt-job-result.mjs";

test("buildAsyncReceiptJobResultFromHttpBody: 正常なオブジェクトは completed", () => {
  const body = JSON.stringify({ ok: true, summary: { vendorName: "店" }, items: [] });
  const { status, resultData } = buildAsyncReceiptJobResultFromHttpBody(body);
  assert.equal(status, "completed");
  assert.equal(resultData.ok, true);
});

test("buildAsyncReceiptJobResultFromHttpBody: トップがJSON文字列なら failed", () => {
  const topString = JSON.stringify("Invalid value.");
  const { status, resultData } = buildAsyncReceiptJobResultFromHttpBody(topString);
  assert.equal(status, "failed");
  assert.equal(resultData.error, "not_json_object");
});

test("buildAsyncReceiptJobResultFromHttpBody: 壊れたJSONは failed", () => {
  const { status, resultData } = buildAsyncReceiptJobResultFromHttpBody("not json {");
  assert.equal(status, "failed");
  assert.equal(resultData.error, "invalid_json");
});

test("buildAsyncReceiptJobResultFromHttpBody: 空 body は failed", () => {
  const { status, resultData } = buildAsyncReceiptJobResultFromHttpBody("   ");
  assert.equal(status, "failed");
  assert.equal(resultData.error, "empty_response_body");
});

test("receiptJobResultDataForMysqlBinding: MySQL JSON 用に常にオブジェクト", () => {
  const err = buildReceiptJobErrorData({
    kind: "parse_http_error",
    message: "bad",
    rawText: "x",
    httpStatus: 500,
  });
  const b = receiptJobResultDataForMysqlBinding(err);
  assert.equal(typeof b, "object");
  assert.equal(b.error, "parse_http_error");
  assert.doesNotThrow(() => {
    const s = JSON.stringify(b);
    JSON.parse(s);
  });
});

test("receiptJobResultDataForMysqlBinding: 生文字列は正規化される", () => {
  const b = receiptJobResultDataForMysqlBinding(/** @type {any} */("raw"));
  assert.equal(b.error, "not_object");
});
