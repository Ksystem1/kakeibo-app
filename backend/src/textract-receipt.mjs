/**
 * Amazon Textract AnalyzeExpense — レシート画像の解析とレスポンス整形
 */
import {
  AnalyzeExpenseCommand,
  TextractClient,
} from "@aws-sdk/client-textract";

const DEFAULT_REGION = "ap-northeast-1";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // Textract 同期 API の上限に合わせる

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getRegion() {
  return (
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    DEFAULT_REGION
  );
}

function textractDisabled() {
  return String(process.env.TEXTRACT_ENABLED || "").toLowerCase() === "false";
}

function fieldType(f) {
  return String(f?.Type?.Text ?? "")
    .trim()
    .toUpperCase();
}

function fieldText(f) {
  return String(f?.ValueDetection?.Text ?? "").trim();
}

function fieldConfidence01(f) {
  const c = f?.ValueDetection?.Confidence;
  if (typeof c !== "number" || Number.isNaN(c)) return null;
  return Math.round((c / 100) * 1000) / 1000;
}

/** 金額らしき文字列を数値化（円記号・カンマ対応） */
function parseMoney(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).replace(/[¥￥,\s]/g, "").replace(/円/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** 日付を YYYY-MM-DD に寄せる（Textract の表記ゆれ用の軽い正規化） */
function normalizeDateText(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) {
    const y = iso[1];
    const mo = iso[2].padStart(2, "0");
    const d = iso[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (jp) {
    return `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`;
  }
  return s;
}

function summaryFromFields(summaryFields) {
  /** @type {{ vendorName: string | null; totalAmount: number | null; date: string | null; fieldConfidence: Record<string, number | null> }} */
  const out = {
    vendorName: null,
    totalAmount: null,
    date: null,
    fieldConfidence: {},
  };
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

    if (
      t === "VENDOR_NAME" ||
      t === "RECEIVER_NAME" ||
      t === "NAME" ||
      t === "MERCHANT_NAME"
    ) {
      if (text && !out.vendorName) {
        out.vendorName = text;
        out.fieldConfidence.vendorName = conf;
      }
    }

    if (t === "TOTAL" || t === "AMOUNT_PAID" || t === "TOTAL_AMOUNT") {
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

    if (
      t === "INVOICE_RECEIPT_DATE" ||
      t === "DATE" ||
      t === "TRANSACTION_DATE" ||
      t === "ORDER_DATE"
    ) {
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
      /** @type {Record<string, unknown>} */
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
      const priceRaw =
        fieldText(map.PRICE) ||
        fieldText(map.UNIT_PRICE) ||
        fieldText(map.AMOUNT);
      const amount = parseMoney(priceRaw);
      const conf =
        fieldConfidence01(map.PRICE) ??
        fieldConfidence01(map.UNIT_PRICE) ??
        fieldConfidence01(map.ITEM);
      rows.push({
        name,
        amount,
        confidence: conf ?? undefined,
      });
    }
  }
  return rows;
}

/**
 * data URL または生 base64 から Buffer を得る
 * @param {string} imageBase64
 */
export function decodeImageBuffer(imageBase64) {
  let s = String(imageBase64 ?? "").trim();
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(s);
  if (dataUrl) s = dataUrl[1].replace(/\s/g, "");
  else s = s.replace(/\s/g, "");
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

/**
 * @param {Buffer} imageBytes
 * @param {{ logError?: (event: string, e: unknown, extra?: object) => void }} [ctx]
 */
export async function analyzeReceiptImageBytes(imageBytes, ctx = {}) {
  const { logError = () => {} } = ctx;
  const maxBytes = envInt("TEXTRACT_MAX_IMAGE_BYTES", DEFAULT_MAX_BYTES);
  if (imageBytes.length > maxBytes) {
    const err = new Error(
      `画像サイズが上限（${maxBytes} bytes）を超えています。小さな画像で試してください。`,
    );
    err.code = "ImageTooLarge";
    err.statusCode = 413;
    throw err;
  }

  if (textractDisabled()) {
    const err = new Error(
      "Textract が無効です（TEXTRACT_ENABLED=false）。環境変数を確認してください。",
    );
    err.code = "TextractDisabled";
    err.statusCode = 503;
    throw err;
  }

  const region = getRegion();
  const timeoutMs = envInt("TEXTRACT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  const client = new TextractClient({
    region,
    maxAttempts: Math.max(1, envInt("TEXTRACT_MAX_ATTEMPTS", 2)),
  });

  const command = new AnalyzeExpenseCommand({
    Document: { Bytes: new Uint8Array(imageBytes) },
  });

  let response;
  try {
    response = await client.send(command, {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw mapTextractSdkError(e, timeoutMs, logError);
  }

  const docs = response.ExpenseDocuments;
  if (!Array.isArray(docs) || docs.length === 0) {
    return {
      summary: {
        vendorName: null,
        totalAmount: null,
        date: null,
        fieldConfidence: {},
      },
      items: [],
      notice:
        "Textract は応答しましたが、経費ドキュメントが検出されませんでした。画像がレシートであるか確認してください。",
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
}

/**
 * @param {unknown} e
 * @param {number} timeoutMs
 * @param {(event: string, err: unknown, extra?: object) => void} logError
 */
function mapTextractSdkError(e, timeoutMs, logError) {
  const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
  const msg =
    e && typeof e === "object" && "message" in e && typeof e.message === "string"
      ? e.message
      : String(e);

  if (name === "TimeoutError" || /aborted|timeout/i.test(msg)) {
    logError("textract.timeout", e, { timeoutMs });
    const err = new Error(
      `Textract 呼び出しがタイムアウトしました（${timeoutMs}ms）。TEXTRACT_TIMEOUT_MS を延ばすか、画像を小さくしてください。`,
    );
    err.code = "TextractTimeout";
    err.statusCode = 504;
    return err;
  }

  if (
    name === "ThrottlingException" ||
    name === "ProvisionedThroughputExceededException"
  ) {
    logError("textract.throttle", e, {});
    const err = new Error(
      "Textract のレート制限に達しました。しばらく待ってから再試行してください。",
    );
    err.code = "TextractThrottled";
    err.statusCode = 429;
    return err;
  }

  if (
    name === "BadDocumentException" ||
    name === "InvalidParameterException" ||
    name === "UnsupportedDocumentException"
  ) {
    logError("textract.bad_request", e, { name });
    const err = new Error(
      `画像を Textract で処理できませんでした: ${msg}`,
    );
    err.code = name;
    err.statusCode = 400;
    return err;
  }

  if (name === "DocumentTooLargeException") {
    logError("textract.too_large", e, {});
    const err = new Error("Textract がドキュメントサイズ上限を超えていると判断しました。");
    err.code = "DocumentTooLargeException";
    err.statusCode = 413;
    return err;
  }

  if (
    name === "ServiceUnavailableException" ||
    name === "InternalServerError"
  ) {
    logError("textract.service", e, { name });
    const err = new Error("Textract 側が一時的に利用できません。しばらくしてから再試行してください。");
    err.code = name;
    err.statusCode = 503;
    return err;
  }

  if (
    name === "CredentialsProviderError" ||
    /credentials|Could not load credentials/i.test(msg)
  ) {
    logError("textract.credentials", e, { name });
    const err = new Error(
      "AWS 認証情報が取得できません。App Runner のインスタンスロールに textract:AnalyzeExpense を付与し、ローカルでは AWS_PROFILE 等を設定するか TEXTRACT_ENABLED=false にしてください。",
    );
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
