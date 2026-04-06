/**
 * Amazon Textract AnalyzeExpense — レシート画像の解析とレスポンス整形
 * - ECS / App Runner いずれでも使えるよう、AWS 設定は注入可能にする
 * - 一時的なネットワーク異常は限定リトライ（標準 DNS / Node の lookup を使用）
 */
import { AnalyzeExpenseCommand, TextractClient } from "@aws-sdk/client-textract";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpsAgent } from "node:https";

const DEFAULT_REGION = "ap-northeast-1";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SEND_RETRIES = 1;

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getDefaultAwsConfig() {
  const region =
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    DEFAULT_REGION;
  // カスタム lookup（DoH 等）は、一部環境で callback に undefined IP が渡り
  // 「Invalid IP address: undefined」になるため使わない。標準 DNS + NAT/VPC で解決する。
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 50,
  });
  return {
    region,
    maxAttempts: Math.max(1, envInt("TEXTRACT_MAX_ATTEMPTS", 2)),
    requestHandler: new NodeHttpHandler({
      httpsAgent,
      connectionTimeout: Math.max(1, envInt("TEXTRACT_CONNECT_TIMEOUT_MS", 3_000)),
      socketTimeout: Math.max(1, envInt("TEXTRACT_SOCKET_TIMEOUT_MS", 12_000)),
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
function fieldLabel(f) {
  return String(f?.LabelDetection?.Text ?? "").trim();
}
function compactLabel(label) {
  return String(label || "")
    .trim()
    .replace(/\s/g, "")
    .replace(/[　]/g, "");
}

/** お釣り・釣銭・預り（合計ではない金額欄） */
function looksLikeChangeOrTenderLabel(label) {
  const c = compactLabel(label);
  if (!c) return false;
  return /(お釣|つり|おつり|釣銭|釣り|変更|預り|お預かり|預かり|お預り|change\s*due|changes?\s*given|cash\s*back)/i.test(
    c,
  );
}

function looksLikeTotalLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return false;
  const c = raw.replace(/\s/g, "").replace(/[　]/g, "");
  if (/(お釣|つり|おつり|変更|釣銭|釣り|預り|お預かり)/i.test(c)) return false;
  return /合計|税込(?:額)?|御購入|お買上|支払(?:い)?(?:金額)?|ご利用|お支払|総額|お会計|^Total$|^TOTAL$/i.test(
    c,
  );
}

const TOTAL_FIELD_TYPES = new Set([
  "TOTAL",
  "TOTAL_AMOUNT",
  "AMOUNT_PAID",
  "TOTAL_AMOUNT_PAID",
  "AMOUNT_DUE",
  "BALANCE",
  "GRAND_TOTAL",
  "INVOICE_TOTAL",
  "TOTAL_PRICE",
  "NET_AMOUNT",
]);
function fieldConfidence01(f) {
  const c = f?.ValueDetection?.Confidence;
  if (typeof c !== "number" || Number.isNaN(c)) return null;
  return Math.round((c / 100) * 1000) / 1000;
}
function parseMoney(raw) {
  if (raw == null || raw === "") return null;
  let s = String(raw)
    .replace(/[¥￥,\s]/g, "")
    .replace(/，/g, "")
    .replace(/円/g, "");
  s = s.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function normalizeDateText(raw) {
  if (raw == null || raw === "") return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[（(].*[)）]/g, "").trim();
  s = s.replace(/T.*$/i, "").replace(/\s+.*$/, "").trim();
  s = s.replace(/\s/g, "").replace(/[　]/g, "");

  const rei = /令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (rei) {
    const y = 2018 + Number.parseInt(rei[1], 10);
    return `${y}-${rei[2].padStart(2, "0")}-${rei[3].padStart(2, "0")}`;
  }
  const hei = /平成\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (hei) {
    const y = 1988 + Number.parseInt(hei[1], 10);
    return `${y}-${hei[2].padStart(2, "0")}-${hei[3].padStart(2, "0")}`;
  }
  const sho = /昭和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (sho) {
    const y = 1925 + Number.parseInt(sho[1], 10);
    return `${y}-${sho[2].padStart(2, "0")}-${sho[3].padStart(2, "0")}`;
  }

  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`;

  const reiShort = /^R(\d{1,2})[./-](\d{1,2})[./-](\d{1,2})$/i.exec(s);
  if (reiShort) {
    const y = 2018 + Number.parseInt(reiShort[1], 10);
    return `${y}-${reiShort[2].padStart(2, "0")}-${reiShort[3].padStart(2, "0")}`;
  }

  const isoLike = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (isoLike) {
    return `${isoLike[1]}-${isoLike[2].padStart(2, "0")}-${isoLike[3].padStart(2, "0")}`;
  }

  const ymdDot = /^(\d{4})[.](\d{1,2})[.](\d{1,2})$/.exec(s);
  if (ymdDot) {
    return `${ymdDot[1]}-${ymdDot[2].padStart(2, "0")}-${ymdDot[3].padStart(2, "0")}`;
  }

  const compact8 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact8) {
    return `${compact8[1]}-${compact8[2]}-${compact8[3]}`;
  }

  const us = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;

  const mdY2 = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(s);
  if (mdY2) {
    const n = Number.parseInt(mdY2[3], 10);
    const y = n >= 70 ? 1900 + n : 2000 + n;
    return `${y}-${mdY2[1].padStart(2, "0")}-${mdY2[2].padStart(2, "0")}`;
  }

  const ymdShort = /^(\d{2})[./-](\d{1,2})[./-](\d{1,2})$/.exec(s);
  if (ymdShort) {
    const n = Number.parseInt(ymdShort[1], 10);
    const y = n >= 70 ? 1900 + n : 2000 + n;
    return `${y}-${ymdShort[2].padStart(2, "0")}-${ymdShort[3].padStart(2, "0")}`;
  }

  const laxJp = /(20\d{2}|19\d{2})年(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (laxJp) {
    return `${laxJp[1]}-${laxJp[2].padStart(2, "0")}-${laxJp[3].padStart(2, "0")}`;
  }
  const laxIso = /(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (laxIso) {
    return `${laxIso[1]}-${laxIso[2].padStart(2, "0")}-${laxIso[3].padStart(2, "0")}`;
  }
  const laxR = /R(\d{1,2})[./-](\d{1,2})[./-](\d{1,2})/i.exec(s);
  if (laxR) {
    const y = 2018 + Number.parseInt(laxR[1], 10);
    return `${y}-${laxR[2].padStart(2, "0")}-${laxR[3].padStart(2, "0")}`;
  }

  return null;
}

function extractDateFromText(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw);
  const direct = normalizeDateText(s);
  if (direct) return direct;
  const patterns = [
    /(令和\s*\d{1,2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?)/,
    /(平成\s*\d{1,2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?)/,
    /(昭和\s*\d{1,2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?)/,
    /((?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2})/,
    /((?:19|20)\d{2}年\d{1,2}月\d{1,2}日?)/,
    /(R\d{1,2}[./-]\d{1,2}[./-]\d{1,2})/i,
    /(\d{8})/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const d = normalizeDateText(m[1]);
    if (d) return d;
  }
  return null;
}

/** SummaryFields 全体から日付らしい文字列を拾う（型付きフィールドに無い場合） */
function fallbackDateFromSummaryFields(summaryFields) {
  if (!Array.isArray(summaryFields)) return null;
  for (const f of summaryFields) {
    const chunks = [fieldText(f), fieldLabel(f)].filter(Boolean);
    for (const c of chunks) {
      const d = extractDateFromText(c);
      if (d) return d;
    }
  }
  return null;
}

const VENDOR_SUMMARY_TYPES = new Set([
  "VENDOR_NAME",
  "RECEIVER_NAME",
  "NAME",
  "MERCHANT_NAME",
  "VENDOR",
  "SELLER_NAME",
  "STORE_NAME",
]);

const DATE_SUMMARY_TYPES = new Set([
  "INVOICE_RECEIPT_DATE",
  "DATE",
  "TRANSACTION_DATE",
  "ORDER_DATE",
  "RECEIPT_DATE",
  "PAYMENT_DATE",
  "DUE_DATE",
  "DOCUMENT_DATE",
  "SERVICE_DATE",
  "DELIVERY_DATE",
  "SHIP_DATE",
  "TIME_PERIOD_START",
  "TIME_PERIOD_END",
]);

/** 値・ラベルに「お釣り」等が含まれる（TOTAL 型でも除外） */
function valueOrLabelSuggestsChange(text, label) {
  const blob = `${String(text ?? "")} ${String(label ?? "")}`.replace(/\s/g, "").replace(/[　]/g, "");
  return /(お釣|つり|おつり|釣銭|釣り|預り|お預かり|預かり|お預り|change\s*due|changes?\s*given)/i.test(
    blob,
  );
}

function summaryFromFields(summaryFields) {
  const out = { vendorName: null, totalAmount: null, date: null, fieldConfidence: {} };
  if (!Array.isArray(summaryFields)) return out;
  /** @type {Array<{ amt: number; conf: number | null; label: string; preferred: boolean }>} */
  const totalCandidates = [];
  const vendorCandidates = [];
  let subtotal = null;
  let subtotalConf = null;
  let tax = null;
  let taxConf = null;
  for (const f of summaryFields) {
    const t = fieldType(f);
    const text = fieldText(f);
    const label = fieldLabel(f);
    const conf = fieldConfidence01(f);

    if (!t) {
      if (!out.date) {
        const d = extractDateFromText(text) ?? extractDateFromText(label);
        if (d) {
          out.date = d;
          out.fieldConfidence.date = conf;
        }
      }
      continue;
    }

    if (VENDOR_SUMMARY_TYPES.has(t) && text) {
      vendorCandidates.push({ text, conf: typeof conf === "number" ? conf : 0 });
    }
    if (TOTAL_FIELD_TYPES.has(t)) {
      const amt = parseMoney(text);
      if (
        amt != null &&
        !looksLikeChangeOrTenderLabel(label) &&
        !valueOrLabelSuggestsChange(text, label)
      ) {
        totalCandidates.push({
          amt,
          conf,
          label,
          preferred: looksLikeTotalLabel(label),
        });
      }
    }
    if (t === "OTHER" && looksLikeTotalLabel(label)) {
      const amt = parseMoney(text);
      if (amt != null && !looksLikeChangeOrTenderLabel(label)) {
        totalCandidates.push({ amt, conf, label, preferred: true });
      }
    }
    if (t === "SUBTOTAL") {
      const amt = parseMoney(text);
      if (amt != null) {
        subtotal = amt;
        subtotalConf = conf;
      }
    }
    if (t === "TAX" || t === "TOTAL_TAX" || t === "VAT") {
      const amt = parseMoney(text);
      if (amt != null) {
        tax = amt;
        taxConf = conf;
      }
    }
    if (DATE_SUMMARY_TYPES.has(t)) {
      const d = extractDateFromText(text) ?? extractDateFromText(label);
      if (d && !out.date) {
        out.date = d;
        out.fieldConfidence.date = conf;
      }
    }
  }
  if (!out.date) {
    const fb = fallbackDateFromSummaryFields(summaryFields);
    if (fb) {
      out.date = fb;
      out.fieldConfidence.date = out.fieldConfidence.date ?? null;
    }
  }
  if (vendorCandidates.length > 0) {
    vendorCandidates.sort(
      (a, b) => b.conf - a.conf || b.text.length - a.text.length || a.text.localeCompare(b.text),
    );
    const best = vendorCandidates[0];
    out.vendorName = best.text;
    out.fieldConfidence.vendorName = best.conf;
  }
  if (totalCandidates.length > 0) {
    totalCandidates.sort((a, b) => {
      if (a.preferred !== b.preferred) return (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0);
      const ca = a.conf ?? 0;
      const cb = b.conf ?? 0;
      if (Math.abs(cb - ca) > 0.001) return cb - ca;
      return b.amt - a.amt;
    });
    out.totalAmount = totalCandidates[0].amt;
    out.fieldConfidence.totalAmount = totalCandidates[0].conf;
  } else if (subtotal != null && tax != null) {
    out.totalAmount = Math.round((subtotal + tax) * 100) / 100;
    out.fieldConfidence.totalAmount = Math.min(
      subtotalConf ?? 1,
      taxConf ?? 1,
    );
  }
  return out;
}

function fallbackTotalFromLineItems(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    if (looksLikeChangeOrTenderLabel(String(row?.name ?? ""))) continue;
    const a = row?.amount;
    if (typeof a === "number" && Number.isFinite(a) && a > 0) {
      sum += a;
      n += 1;
    }
  }
  if (n === 0) return null;
  return Math.round(sum * 100) / 100;
}

function fallbackDateFromLineItems(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  for (const row of rows) {
    const d = extractDateFromText(String(row?.name ?? ""));
    if (d) return d;
  }
  return null;
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
        fieldText(map.DESCRIPTION) ||
        fieldText(map.PRODUCT_NAME) ||
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
    let notice = null;
    let totalAmount = summary.totalAmount;
    let fieldConfidence = { ...summary.fieldConfidence };
    if (totalAmount == null) {
      const fb = fallbackTotalFromLineItems(items);
      if (fb != null) {
        totalAmount = fb;
        fieldConfidence = { ...fieldConfidence, totalAmount: null };
        notice =
          "合計欄を自動検出できなかったため、明細行の金額を合算して推定しました。必要に応じて修正してください。";
      }
    }
    let dateVal = summary.date;
    if (!dateVal) {
      dateVal = fallbackDateFromLineItems(items);
      if (dateVal) {
        fieldConfidence = { ...fieldConfidence, date: fieldConfidence.date ?? null };
      }
    }
    return {
      summary: {
        vendorName: summary.vendorName,
        totalAmount,
        date: dateVal,
        fieldConfidence,
      },
      items,
      notice,
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
