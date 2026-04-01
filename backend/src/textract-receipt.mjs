/**
 * Amazon Textract AnalyzeExpense — レシート画像の解析とレスポンス整形
 * - ECS / App Runner いずれでも使えるよう、AWS 設定は注入可能にする
 * - 一時的な DNS/ネットワーク異常（例: getaddrinfo EBUSY）は限定リトライ
 */
import { AnalyzeExpenseCommand, TextractClient } from "@aws-sdk/client-textract";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import dns from "node:dns";
import { Agent as HttpsAgent } from "node:https";

const DEFAULT_REGION = "ap-northeast-1";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SEND_RETRIES = 4;

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getDefaultAwsConfig() {
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 50,
    lookup(hostname, options, callback) {
      // App Runner 環境での一時 DNS 失敗を減らすため IPv4 を優先
      return dns.lookup(hostname, { ...options, family: 4 }, callback);
    },
  });
  return {
    region:
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      DEFAULT_REGION,
    maxAttempts: Math.max(1, envInt("TEXTRACT_MAX_ATTEMPTS", 2)),
    requestHandler: new NodeHttpHandler({
      httpsAgent,
      connectionTimeout: Math.max(1, envInt("TEXTRACT_CONNECT_TIMEOUT_MS", 5_000)),
      socketTimeout: Math.max(1, envInt("TEXTRACT_SOCKET_TIMEOUT_MS", 30_000)),
    }),
  };
}

function textractDisabled() {
  return String(process.env.TEXTRACT_ENABLED || "").toLowerCase() === "false";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  const base = 250 * 2 ** Math.max(0, attempt - 1);
  return base + Math.floor(Math.random() * 150);
}

function isTransientNetworkError(e) {
  const msg = String(e?.message ?? "");
  const code = String(e?.code ?? "");
  const name = String(e?.name ?? "");
  return (
    /getaddrinfo\s+EBUSY/i.test(msg) ||
    /EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg) ||
    code === "EBUSY" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    name === "TimeoutError"
  );
}

function fieldType(f) {
  return String(f?.Type?.Text ?? "").trim().toUpperCase();
}
function fieldText(f) {
  return String(f?.ValueDetection?.Text ?? "").trim();
}
function fieldConfidence01(f) {
  const c = f?.ValueDetection?.Confidence;
  if (typeof c !== "number" || Number.isNaN(c)) return null;
  return Math.round((c / 100) * 1000) / 1000;
}
function parseMoney(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).replace(/[¥￥,\s]/g, "").replace(/円/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function normalizeDateText(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`;
  return s;
}

function summaryFromFields(summaryFields) {
  const out = { vendorName: null, totalAmount: null, date: null, fieldConfidence: {} };
  if (!Array.isArray(summaryFields)) return out;
  let totalPrimary = null;
  let totalPrimaryConf = null;
  let subtotal = null;
  let subtotalConf = null;
  for (const f of summaryFields) {
    const t = fieldType(f);
    const text = fieldText(f);
    const conf = fieldConfidence01(f);
    if (!t) continue;
    if (["VENDOR_NAME", "RECEIVER_NAME", "NAME", "MERCHANT_NAME"].includes(t)) {
      if (text && !out.vendorName) {
        out.vendorName = text;
        out.fieldConfidence.vendorName = conf;
      }
    }
    if (["TOTAL", "AMOUNT_PAID", "TOTAL_AMOUNT"].includes(t)) {
      const amt = parseMoney(text);
      if (amt != null) {
        totalPrimary = amt;
        totalPrimaryConf = conf;
      }
    }
    if (t === "SUBTOTAL") {
      const amt = parseMoney(text);
      if (amt != null) {
        subtotal = amt;
        subtotalConf = conf;
      }
    }
    if (["INVOICE_RECEIPT_DATE", "DATE", "TRANSACTION_DATE", "ORDER_DATE"].includes(t)) {
      const d = normalizeDateText(text);
      if (d && !out.date) {
        out.date = d;
        out.fieldConfidence.date = conf;
      }
    }
  }
  if (totalPrimary != null) {
    out.totalAmount = totalPrimary;
    out.fieldConfidence.totalAmount = totalPrimaryConf;
  } else if (subtotal != null) {
    out.totalAmount = subtotal;
    out.fieldConfidence.totalAmount = subtotalConf;
  }
  return out;
}

function lineItemsFromExpenseDoc(doc) {
  const rows = [];
  const groups = doc?.LineItemGroups;
  if (!Array.isArray(groups)) return rows;
  for (const g of groups) {
    const items = g?.LineItems;
    if (!Array.isArray(items)) continue;
    for (const li of items) {
      const fields = li?.LineItemExpenseFields;
      if (!Array.isArray(fields)) continue;
      const map = {};
      for (const f of fields) {
        const t = fieldType(f);
        if (t) map[t] = f;
      }
      const name =
        fieldText(map.ITEM) ||
        fieldText(map.EXPENSE_ROW) ||
        fieldText(map.PRODUCT_CODE) ||
        "（品目）";
      const amount = parseMoney(
        fieldText(map.PRICE) || fieldText(map.UNIT_PRICE) || fieldText(map.AMOUNT),
      );
      const confidence =
        fieldConfidence01(map.PRICE) ??
        fieldConfidence01(map.UNIT_PRICE) ??
        fieldConfidence01(map.ITEM) ??
        undefined;
      rows.push({ name, amount, confidence });
    }
  }
  return rows;
}

export function decodeImageBuffer(imageBase64) {
  let s = String(imageBase64 ?? "").trim();
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(s);
  s = dataUrl ? dataUrl[1].replace(/\s/g, "") : s.replace(/\s/g, "");
  if (!s) {
    const err = new Error("imageBase64 が空です");
    err.code = "MissingImage";
    err.statusCode = 400;
    throw err;
  }
  try {
    return Buffer.from(s, "base64");
  } catch {
    const err = new Error("base64 のデコードに失敗しました");
    err.code = "InvalidBase64";
    err.statusCode = 400;
    throw err;
  }
}

export function createReceiptAnalyzer(ctx = {}) {
  const awsConfig = { ...getDefaultAwsConfig(), ...(ctx.awsConfig ?? {}) };
  const makeClient =
    ctx.makeClient ??
    ((config) => new TextractClient(config));
  const client = makeClient(awsConfig);
  const logError = ctx.logError ?? (() => {});
  const timeoutMs = Math.max(1, ctx.timeoutMs ?? envInt("TEXTRACT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(1, ctx.maxBytes ?? envInt("TEXTRACT_MAX_IMAGE_BYTES", DEFAULT_MAX_BYTES));
  const sendRetries = Math.max(
    0,
    ctx.sendRetries ?? envInt("TEXTRACT_SEND_RETRIES", DEFAULT_SEND_RETRIES),
  );

  return async function analyzeReceiptImageBytes(imageBytes) {
    if (imageBytes.length > maxBytes) {
      const err = new Error(`画像サイズが上限（${maxBytes} bytes）を超えています。`);
      err.code = "ImageTooLarge";
      err.statusCode = 413;
      throw err;
    }
    if (textractDisabled()) {
      const err = new Error("Textract が無効です（TEXTRACT_ENABLED=false）。");
      err.code = "TextractDisabled";
      err.statusCode = 503;
      throw err;
    }

    const command = new AnalyzeExpenseCommand({
      Document: { Bytes: new Uint8Array(imageBytes) },
    });

    let response;
    for (let attempt = 1; attempt <= sendRetries + 1; attempt += 1) {
      try {
        response = await client.send(command, {
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        break;
      } catch (e) {
        const retryable = isTransientNetworkError(e);
        if (retryable && attempt <= sendRetries) {
          logError("textract.network_retry", e, { attempt, sendRetries });
          await sleep(backoffMs(attempt));
          continue;
        }
        throw mapTextractSdkError(e, timeoutMs, logError);
      }
    }

    const docs = response?.ExpenseDocuments;
    if (!Array.isArray(docs) || docs.length === 0) {
      return {
        summary: { vendorName: null, totalAmount: null, date: null, fieldConfidence: {} },
        items: [],
        notice: "Textract は応答しましたが、経費ドキュメントを検出できませんでした。",
        expenseIndex: null,
      };
    }

    const doc = docs[0];
    const summary = summaryFromFields(doc.SummaryFields);
    const items = lineItemsFromExpenseDoc(doc);
    return {
      summary: {
        vendorName: summary.vendorName,
        totalAmount: summary.totalAmount,
        date: summary.date,
        fieldConfidence: summary.fieldConfidence,
      },
      items,
      notice: null,
      expenseIndex: doc.ExpenseIndex ?? null,
    };
  };
}

const defaultAnalyzer = createReceiptAnalyzer();

/**
 * @param {Buffer} imageBytes
 * @param {{ analyze?: (b: Buffer) => Promise<any> }} [ctx]
 */
export async function analyzeReceiptImageBytes(imageBytes, ctx = {}) {
  const analyze =
    ctx.analyze ??
    (ctx.logError
      ? createReceiptAnalyzer({ logError: ctx.logError })
      : defaultAnalyzer);
  return analyze(imageBytes);
}

function mapTextractSdkError(e, timeoutMs, logError) {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? e ?? "");
  if (name === "TimeoutError" || /aborted|timeout/i.test(msg)) {
    logError("textract.timeout", e, { timeoutMs });
    const err = new Error(`Textract 呼び出しがタイムアウトしました（${timeoutMs}ms）。`);
    err.code = "TextractTimeout";
    err.statusCode = 504;
    return err;
  }
  if (name === "ThrottlingException" || name === "ProvisionedThroughputExceededException") {
    logError("textract.throttle", e);
    const err = new Error("Textract のレート制限です。時間を空けて再試行してください。");
    err.code = "TextractThrottled";
    err.statusCode = 429;
    return err;
  }
  if (isTransientNetworkError(e)) {
    logError("textract.network_busy", e);
    const err = new Error(
      "Textract への接続が一時的に不安定です（DNS/ネットワーク）。しばらくして再試行してください。",
    );
    err.code = "TextractNetworkBusy";
    err.statusCode = 503;
    return err;
  }
  if (
    name === "BadDocumentException" ||
    name === "InvalidParameterException" ||
    name === "UnsupportedDocumentException"
  ) {
    logError("textract.bad_request", e, { name });
    const err = new Error(`画像を Textract で処理できませんでした: ${msg}`);
    err.code = name;
    err.statusCode = 400;
    return err;
  }
  if (name === "DocumentTooLargeException") {
    logError("textract.too_large", e);
    const err = new Error("Textract のサイズ上限を超えています。");
    err.code = "DocumentTooLargeException";
    err.statusCode = 413;
    return err;
  }
  if (name === "ServiceUnavailableException" || name === "InternalServerError") {
    logError("textract.service", e, { name });
    const err = new Error("Textract 側が一時的に利用できません。");
    err.code = name;
    err.statusCode = 503;
    return err;
  }
  if (name === "CredentialsProviderError" || /credentials|Could not load credentials/i.test(msg)) {
    logError("textract.credentials", e, { name });
    const err = new Error("AWS 認証情報が取得できません。タスクロール/IAM ロールを確認してください。");
    err.code = "AwsCredentials";
    err.statusCode = 503;
    return err;
  }
  logError("textract.unhandled", e, { name });
  const err = new Error(`Textract エラー: ${msg}`);
  err.code = name || "TextractError";
  err.statusCode = 502;
  return err;
}
