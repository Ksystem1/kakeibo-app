/**
 * Amazon Textract AnalyzeExpense — レシート画像の解析とレスポンス整形
 * - ECS / App Runner いずれでも使えるよう、AWS 設定は注入可能にする
 * - 一時的なネットワーク異常は限定リトライ（標準 DNS / Node の lookup を使用）
 */
import { AnalyzeExpenseCommand, TextractClient } from "@aws-sdk/client-textract";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpsAgent } from "node:https";
import crypto from "node:crypto";

const DEFAULT_REGION = "ap-northeast-1";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SEND_RETRIES = 4;
const DEFAULT_S3_PREFIX = "receipts/raw";

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
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY ?? "").trim();
  const sessionToken = String(process.env.AWS_SESSION_TOKEN ?? "").trim();
  const credentials =
    accessKeyId && secretAccessKey
      ? {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        }
      : undefined;
  return {
    region,
    ...(credentials ? { credentials } : {}),
    maxAttempts: Math.max(1, envInt("TEXTRACT_MAX_ATTEMPTS", 2)),
    requestHandler: new NodeHttpHandler({
      httpsAgent,
      connectionTimeout: Math.max(1, envInt("TEXTRACT_CONNECT_TIMEOUT_MS", 3_000)),
      socketTimeout: Math.max(1, envInt("TEXTRACT_SOCKET_TIMEOUT_MS", 12_000)),
    }),
  };
}

function textractUseS3Mode() {
  const v = String(process.env.TEXTRACT_USE_S3 ?? "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

function textractS3Bucket() {
  const candidates = [
    process.env.TEXTRACT_SOURCE_S3_BUCKET,
    process.env.TEXTRACT_S3_BUCKET,
    process.env.RECEIPT_SOURCE_S3_BUCKET,
    process.env.AWS_S3_BUCKET,
    process.env.S3_BUCKET,
    process.env.TEXTRACT_SOURCE_S3_BUCKET_DEFAULT,
  ];
  for (const v of candidates) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function textractS3Prefix() {
  const raw = String(process.env.TEXTRACT_SOURCE_S3_PREFIX ?? DEFAULT_S3_PREFIX).trim();
  return raw.replace(/^\/+|\/+$/g, "");
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
function looksLikeTaxLabel(label) {
  const c = compactLabel(label);
  if (!c) return false;
  return /税|消費税|内税|外税|vat|gst|tax/.test(c);
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
  // OCR が桁区切りカンマをドット誤認するケース（例: 253.76 => 25376）を補正
  if (/^\d{1,3}\.\d{2,3}$/.test(s)) {
    const [lhs, rhs] = s.split(".");
    if ((rhs.length === 2 || rhs.length === 3) && Number.parseInt(lhs, 10) >= 100) {
      s = `${lhs}${rhs}`;
    }
  }
  // 通貨欄は円建て想定のため、末尾小数は整数へ寄せる
  if (/^\d+\.\d+$/.test(s)) {
    const n0 = Number.parseFloat(s);
    if (Number.isFinite(n0) && n0 >= 1000) {
      return Math.round(n0);
    }
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function isValidYmd(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return false;
  if (yy < 1970 || yy > 2100) return false;
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  return (
    dt.getUTCFullYear() === yy &&
    dt.getUTCMonth() + 1 === mm &&
    dt.getUTCDate() === dd
  );
}
function toYmdOrNull(y, m, d) {
  if (!isValidYmd(y, m, d)) return null;
  return `${String(y)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function inferYearForMonthDay(month, day) {
  const now = new Date();
  const year = now.getFullYear();
  const cur = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(cur.getTime())) return year;
  // 年始に前年レシートを読むケースに配慮し、未来に寄りすぎる場合は前年へ。
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = (cur.getTime() - todayUtc) / (24 * 60 * 60 * 1000);
  return diffDays > 45 ? year - 1 : year;
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
    return toYmdOrNull(y, rei[2], rei[3]);
  }
  const hei = /平成\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (hei) {
    const y = 1988 + Number.parseInt(hei[1], 10);
    return toYmdOrNull(y, hei[2], hei[3]);
  }
  const sho = /昭和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (sho) {
    const y = 1925 + Number.parseInt(sho[1], 10);
    return toYmdOrNull(y, sho[2], sho[3]);
  }

  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (jp) return toYmdOrNull(jp[1], jp[2], jp[3]);

  const reiShort = /^R(\d{1,2})[./-](\d{1,2})[./-](\d{1,2})$/i.exec(s);
  if (reiShort) {
    const y = 2018 + Number.parseInt(reiShort[1], 10);
    return toYmdOrNull(y, reiShort[2], reiShort[3]);
  }

  const isoLike = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (isoLike) {
    return toYmdOrNull(isoLike[1], isoLike[2], isoLike[3]);
  }

  const ymdDot = /^(\d{4})[.](\d{1,2})[.](\d{1,2})$/.exec(s);
  if (ymdDot) {
    return toYmdOrNull(ymdDot[1], ymdDot[2], ymdDot[3]);
  }

  const compact8 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact8) {
    return toYmdOrNull(compact8[1], compact8[2], compact8[3]);
  }

  const us = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (us) return toYmdOrNull(us[3], us[1], us[2]);

  const mdY2 = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(s);
  if (mdY2) {
    const n = Number.parseInt(mdY2[3], 10);
    const y = n >= 70 ? 1900 + n : 2000 + n;
    return toYmdOrNull(y, mdY2[1], mdY2[2]);
  }

  const ymdShort = /^(\d{2})[./-](\d{1,2})[./-](\d{1,2})$/.exec(s);
  if (ymdShort) {
    const n = Number.parseInt(ymdShort[1], 10);
    const y = n >= 70 ? 1900 + n : 2000 + n;
    return toYmdOrNull(y, ymdShort[2], ymdShort[3]);
  }

  const laxJp = /(20\d{2}|19\d{2})年(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (laxJp) {
    return toYmdOrNull(laxJp[1], laxJp[2], laxJp[3]);
  }
  const laxIso = /(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (laxIso) {
    return toYmdOrNull(laxIso[1], laxIso[2], laxIso[3]);
  }
  const laxR = /R(\d{1,2})[./-](\d{1,2})[./-](\d{1,2})/i.exec(s);
  if (laxR) {
    const y = 2018 + Number.parseInt(laxR[1], 10);
    return toYmdOrNull(y, laxR[2], laxR[3]);
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
  const hasDateLabel = /日付|発行|購入|会計|ご利用日|取引日時|取引日|利用日|売上日|領収日|receipt\s*date|date/i.test(
    s,
  );
  if (hasDateLabel) {
    const md = /(?:^|[^\d])(\d{1,2})[./-](\d{1,2})(?:$|[^\d])/.exec(s);
    if (md) {
      const month = Number.parseInt(md[1], 10);
      const day = Number.parseInt(md[2], 10);
      const year = inferYearForMonthDay(month, day);
      const ymd = toYmdOrNull(year, month, day);
      if (ymd) return ymd;
    }
    const jpMd = /(?:^|[^\d])(\d{1,2})月(\d{1,2})日/.exec(s);
    if (jpMd) {
      const month = Number.parseInt(jpMd[1], 10);
      const day = Number.parseInt(jpMd[2], 10);
      const year = inferYearForMonthDay(month, day);
      const ymd = toYmdOrNull(year, month, day);
      if (ymd) return ymd;
    }
  }
  return null;
}

/** SummaryFields 全体から日付らしい文字列を拾う（型付きフィールドに無い場合） */
function fallbackDateFromSummaryFields(summaryFields) {
  if (!Array.isArray(summaryFields)) return null;
  for (const f of summaryFields) {
    const text = fieldText(f);
    const label = fieldLabel(f);
    const chunks = [`${label} ${text}`.trim(), text, label].filter(Boolean);
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
          type: t,
          preferred: looksLikeTotalLabel(label),
        });
      }
    }
    if (t === "OTHER" && looksLikeTotalLabel(label)) {
      const amt = parseMoney(text);
      if (amt != null && !looksLikeChangeOrTenderLabel(label)) {
        totalCandidates.push({ amt, conf, label, type: t, preferred: true });
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
      const d = extractDateFromText(`${label} ${text}`) ?? extractDateFromText(text) ?? extractDateFromText(label);
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
    const amountCount = new Map();
    for (const c of totalCandidates) {
      const k = Math.round(Number(c.amt));
      amountCount.set(k, (amountCount.get(k) ?? 0) + 1);
    }
    const subtotalTax = subtotal != null && tax != null ? Math.round((subtotal + tax) * 100) / 100 : null;
    totalCandidates.sort((a, b) => {
      const score = (c) => {
        let s = 0;
        if (c.preferred) s += 3;
        if (c.type === "TOTAL" || c.type === "TOTAL_AMOUNT" || c.type === "TOTAL_AMOUNT_PAID") s += 1.5;
        if (looksLikeTaxLabel(c.label)) s -= 4;
        if (typeof c.conf === "number") s += c.conf * 2;
        const repeated = amountCount.get(Math.round(Number(c.amt))) ?? 0;
        if (repeated >= 2) s += 1.5;
        if (subtotalTax != null && Number.isFinite(subtotalTax) && subtotalTax > 0) {
          const diff = Math.abs(c.amt - subtotalTax);
          const ratio = diff / Math.max(1, subtotalTax);
          if (diff <= 1) s += 3;
          else if (ratio <= 0.06) s += 1.5;
          else if (ratio >= 0.5) s -= 2;
        }
        if (c.amt >= 1_000_000) s -= 1;
        return s;
      };
      const sb = score(b);
      const sa = score(a);
      if (Math.abs(sb - sa) > 0.0001) return sb - sa;
      const cb = b.conf ?? 0;
      const ca = a.conf ?? 0;
      if (Math.abs(cb - ca) > 0.001) return cb - ca;
      if (a.preferred !== b.preferred) return (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0);
      if (Math.abs(a.amt - b.amt) > 0.009) return a.amt - b.amt;
      return 0;
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
  // Textract が「小計 + 税 + 税」と誤結合した候補（例: 15100+1510+1510=18120）を小計+税へ寄せる
  if (out.totalAmount != null && subtotal != null && tax != null) {
    const next = reconcileTotalDoubleTaxError(out.totalAmount, subtotal, tax);
    if (next !== out.totalAmount) {
      out.totalAmount = next;
      out.fieldConfidence.totalAmount = out.fieldConfidence.totalAmount ?? null;
    }
  }
  return out;
}

/**
 * 型付きの小計・税が無くても OCR 行ブロックから拾う（SummaryFields に SUBTOTAL が無い店舗がある）
 * @returns {{ subtotal: number | null, tax: number | null }}
 */
function extractSubtotalTaxFromOcrLines(ocrLines) {
  let subtotal = null;
  let tax = null;
  if (!Array.isArray(ocrLines)) return { subtotal, tax };
  const takeSubtotalNearLine = (idx) => {
    const s = String(ocrLines[idx] ?? "");
    if (!/小計/.test(s) || /合計|総額|お会計/.test(s)) return null;
    const stripped = s.replace(/小計/g, "").trim();
    let nums = moneyCandidatesFromLine(stripped).filter((n) => n >= 50 && n <= 99_999_999);
    if (nums.length === 0 && ocrLines[idx + 1] != null) {
      nums = moneyCandidatesFromLine(ocrLines[idx + 1]).filter((n) => n >= 50 && n <= 99_999_999);
    }
    return nums.length ? Math.max(...nums) : null;
  };
  const takeTaxNearLine = (idx) => {
    const s = String(ocrLines[idx] ?? "");
    if (!/(外税|内税|消費税(?:額)?|内消費税)/.test(s) || /小計|合計|総額|お会計|お支払/.test(s)) {
      return null;
    }
    const stripped = s
      .replace(/外税|内税|消費税(?:額)?|内消費税|内消費税等/g, "")
      .replace(/[（(][^)）]*[)）]/g, "")
      .trim();
    const next = ocrLines[idx + 1] != null ? String(ocrLines[idx + 1]) : "";
    const blob = next ? `${stripped} ${next}` : stripped;
    const nums = moneyCandidatesFromLine(blob).filter((n) => n >= 8 && n <= 99_999_999);
    const large = nums.filter((n) => n >= 50);
    if (large.length) return Math.max(...large);
    return nums.length ? Math.max(...nums) : null;
  };
  for (let i = 0; i < ocrLines.length; i += 1) {
    if (subtotal == null) {
      const v = takeSubtotalNearLine(i);
      if (v != null) subtotal = v;
    }
    if (tax == null) {
      const v = takeTaxNearLine(i);
      if (v != null) tax = v;
    }
    if (subtotal != null && tax != null) return { subtotal, tax };
  }
  return { subtotal, tax };
}

/**
 * @param {unknown} total
 * @param {unknown} subtotal
 * @param {unknown} tax
 * @returns {unknown}
 */
function reconcileTotalDoubleTaxError(total, subtotal, tax) {
  if (total == null || subtotal == null || tax == null) return total;
  const tot = Math.round(Number(total) * 100) / 100;
  const st = Math.round(Number(subtotal) * 100) / 100;
  const tx = Math.round(Number(tax) * 100) / 100;
  if (!Number.isFinite(tot) || tot <= 0 || !Number.isFinite(st) || !Number.isFinite(tx) || tx <= 0) return total;
  const expected = Math.round((st + tx) * 100) / 100;
  const doubleTaxTotal = Math.round((st + tx * 2) * 100) / 100;
  if (Math.abs(tot - doubleTaxTotal) <= 1 && Math.abs(tot - expected) >= 3) return expected;
  return total;
}

/**
 * 品目名が記号のみの重複行を落とす（同じ金額が何度も出て明細合算が膨らむ対策）
 * @param {Array<{ name?: string; amount?: unknown; confidence?: number }>} rows
 */
function dedupeJunkSymbolDuplicateLineItems(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const junkName = (raw) => {
    const s = String(raw ?? "").trim();
    if (!s) return true;
    return /^[\s*・.。_\-+=（）()｜|]+$/.test(s) || (s.length <= 2 && /^[\s*・.。_\-+=（）()]+$/.test(s));
  };
  if (!rows.some((r) => junkName(r?.name))) return rows;
  const seenAmount = new Set();
  const out = [];
  for (const r of rows) {
    const a = Number(r?.amount);
    if (!Number.isFinite(a) || a <= 0) {
      out.push(r);
      continue;
    }
    const key = Math.round(a * 100) / 100;
    if (junkName(r?.name)) {
      if (seenAmount.has(key)) continue;
      seenAmount.add(key);
    }
    out.push(r);
  }
  return out;
}

/**
 * 小計・合計・税・支払方法など「物販明細ではない」行を落とす（合算が63,420のように膨れるのを防ぐ）
 */
function looksLikeSummaryFooterOrPaymentLineName(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  const c = s.replace(/\s/g, "").replace(/[　]/g, "");
  if (
    /(小計|合計|総額|お会計|外税|内税|消費税|税率|対象額|税額|お支払|ご利用金額|領収|内消費税等|登録番号)/i.test(c)
  ) {
    return true;
  }
  if (/J[-\s]?Mups|ムップス|クレジット|credit|visa|master|paypay|ペイペイ|クレジット決済/i.test(c)) {
    return true;
  }
  if (/(?:^|[^a-z])SUBTOTAL|(?:^|[^a-z])TOTAL(?:[^A-Z]|$)/i.test(s)) return true;
  // OCR ノイズだけが残る例: "1/1 it", "40 it"（小計・合計ブロック）
  if (/^\d+\/\d+\s*it$/i.test(s.trim())) return true;
  if (/^\d{1,3}\s*it$/i.test(s.trim())) return true;
  return false;
}

function filterSummaryFooterLineItems(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  return rows.filter((r) => !looksLikeSummaryFooterOrPaymentLineName(r?.name));
}

function fallbackTotalFromLineItems(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const nm = String(row?.name ?? "");
    if (looksLikeChangeOrTenderLabel(nm)) continue;
    if (looksLikeSummaryFooterOrPaymentLineName(nm)) continue;
    const a = row?.amount;
    if (typeof a === "number" && Number.isFinite(a) && a > 0) {
      sum += a;
      n += 1;
    }
  }
  if (n === 0) return null;
  return Math.round(sum * 100) / 100;
}

function lineHasTotalKeyword(line) {
  return /合計|税込(?:額)?|総額|お会計|ご請求|ご利用金額|お支払(?:金額)?|(?:^|[^A-Z])TOTAL(?:[^A-Z]|$)/i.test(
    String(line ?? ""),
  );
}

/** 合計・支払・税込対象額など、税込総額が載りうる OCR ウィンドウ */
function lineLooksLikeGrandTotalContext(line) {
  const s = String(line ?? "");
  return (
    lineHasTotalKeyword(s) ||
    /(?:税込(?:額)?|対象額|税率\s*\d+\s*%\s*対象)/i.test(s) ||
    /(?:J[-\s]?Mups|クレジット).*(?:¥|￥)?\s*\d/i.test(s)
  );
}

/** 上記文脈の OCR ウィンドウに、指定の金額が含まれるか（ブロック分割対策） */
function ocrGrandTotalAmountMatched(ocrLines, amount) {
  const t = Math.round(Number(amount));
  if (!Number.isFinite(t) || t <= 0 || !Array.isArray(ocrLines)) return false;
  const lines = ocrLines.map((x) => String(x ?? "").trim());
  for (let i = 0; i < lines.length; i += 1) {
    const merged = [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join(" ");
    if (!merged || !lineLooksLikeGrandTotalContext(merged)) continue;
    const nums = moneyCandidatesFromLine(merged);
    if (nums.includes(t)) return true;
  }
  return false;
}

/**
 * 正しい税込合計 G に対し、誤って G+税 になったパターン（例 16610+1510=18120）を戻す
 * @param {unknown} total
 * @param {unknown} taxAmt
 * @param {string[]} ocrLines
 */
function reconcileIfTotalEqualsGrandPlusTaxOnce(total, taxAmt, ocrLines) {
  if (total == null || taxAmt == null) return total;
  const tot = Math.round(Number(total) * 100) / 100;
  const tx = Math.round(Number(taxAmt) * 100) / 100;
  if (!Number.isFinite(tot) || tot <= 0 || !Number.isFinite(tx) || tx <= 0) return total;
  const cand = Math.round((tot - tx) * 100) / 100;
  if (cand < 100) return total;
  if (!ocrGrandTotalAmountMatched(ocrLines, cand)) return total;
  if (Math.abs(tot - (cand + tx)) > 2) return total;
  return cand;
}

function lineHasNonTotalKeyword(line) {
  const s = String(line ?? "");
  // 「お支払(税込)」「合計(税込)」など、合計系キーワードと同じ行の表記は落とさない
  if (lineHasTotalKeyword(s)) return false;
  return /小計|税|内税|外税|値引|割引|ポイント|お釣|つり|釣銭|預り|お預かり|現金|cash|change|coupon/i.test(s);
}

function moneyCandidatesFromLine(line) {
  const src = String(line ?? "");
  if (!src) return [];
  const normalized = src.replace(/[¥￥]/g, "").replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  const hits = normalized.match(/\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? [];
  const out = [];
  for (const h of hits) {
    const n = parseMoney(h);
    if (n == null || !Number.isFinite(n) || n <= 0) continue;
    out.push(n);
  }
  return out;
}

function fallbackTotalFromOcrLines(lines, expectedTotal = null) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  /** @type {Array<{ amount: number; score: number }>} */
  const candidates = [];
  for (const line of lines) {
    const amounts = moneyCandidatesFromLine(line);
    if (amounts.length === 0) continue;
    const hasTotal = lineHasTotalKeyword(line);
    if (!hasTotal) continue;
    if (lineHasNonTotalKeyword(line)) continue;
    for (const amount of amounts) {
      let score = 3;
      if (/合計|総額|TOTAL/i.test(String(line))) score += 2;
      if (/お支払|支払|ご請求|請求額/i.test(String(line))) score += 1.5;
      const expected = Number(expectedTotal);
      if (Number.isFinite(expected) && expected > 0) {
        const diff = Math.abs(amount - expected);
        const ratio = diff / Math.max(1, expected);
        if (diff <= 1) score += 4;
        else if (ratio <= 0.08) score += 2;
        else if (ratio >= 0.35) score -= 2;
      }
      candidates.push({ amount, score });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.amount - a.amount);
  return Math.round(candidates[0].amount * 100) / 100;
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

function collectOcrLinesFromExpenseDoc(doc) {
  const lines = [];
  const push = (v) => {
    const s = String(v ?? "").trim();
    if (!s) return;
    lines.push(s);
  };

  for (const f of Array.isArray(doc?.SummaryFields) ? doc.SummaryFields : []) {
    push(fieldLabel(f));
    push(fieldText(f));
  }

  const groups = Array.isArray(doc?.LineItemGroups) ? doc.LineItemGroups : [];
  for (const g of groups) {
    for (const li of Array.isArray(g?.LineItems) ? g.LineItems : []) {
      for (const f of Array.isArray(li?.LineItemExpenseFields) ? li.LineItemExpenseFields : []) {
        push(fieldLabel(f));
        push(fieldText(f));
      }
    }
  }

  const uniq = [];
  const seen = new Set();
  for (const x of lines) {
    if (seen.has(x)) continue;
    seen.add(x);
    uniq.push(x);
  }
  return uniq.slice(0, 180);
}

function toRounded01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const clamped = Math.max(0, Math.min(1, v));
  return Math.round(clamped * 10000) / 10000;
}

function geometryFromAny(node) {
  const bb = node?.Geometry?.BoundingBox;
  if (!bb || typeof bb !== "object") return null;
  const left = toRounded01(bb.Left);
  const top = toRounded01(bb.Top);
  const width = toRounded01(bb.Width);
  const height = toRounded01(bb.Height);
  if (left == null || top == null || width == null || height == null) return null;
  return { left, top, width, height };
}

function collectOcrTextBlocksFromExpenseDoc(doc) {
  /** @type {Array<{ text: string; bbox: { left: number; top: number; width: number; height: number } | null }>} */
  const out = [];
  const pushUnique = (textRaw, geomCandidate) => {
    const text = String(textRaw ?? "").trim();
    if (!text) return;
    const bbox = geometryFromAny(geomCandidate);
    const key = `${text}#${bbox ? `${bbox.left},${bbox.top},${bbox.width},${bbox.height}` : "nogeom"}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, bbox });
  };
  const seen = new Set();

  for (const f of Array.isArray(doc?.SummaryFields) ? doc.SummaryFields : []) {
    if (f?.LabelDetection?.Text) pushUnique(f.LabelDetection.Text, f.LabelDetection);
    if (f?.ValueDetection?.Text) pushUnique(f.ValueDetection.Text, f.ValueDetection);
  }
  const groups = Array.isArray(doc?.LineItemGroups) ? doc.LineItemGroups : [];
  for (const g of groups) {
    for (const li of Array.isArray(g?.LineItems) ? g.LineItems : []) {
      for (const f of Array.isArray(li?.LineItemExpenseFields) ? li.LineItemExpenseFields : []) {
        if (f?.LabelDetection?.Text) pushUnique(f.LabelDetection.Text, f.LabelDetection);
        if (f?.ValueDetection?.Text) pushUnique(f.ValueDetection.Text, f.ValueDetection);
      }
    }
  }
  return out.slice(0, 220);
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
  const useS3Mode = ctx.useS3Mode ?? textractUseS3Mode();
  const sourceBucket = String(ctx.sourceBucket ?? textractS3Bucket()).trim();
  const sourcePrefix = String(ctx.sourcePrefix ?? textractS3Prefix()).trim();
  const s3Client =
    useS3Mode && sourceBucket
      ? new S3Client(awsConfig)
      : null;

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

    const effectiveUseS3 = useS3Mode && sourceBucket.length > 0;
    if (useS3Mode && !effectiveUseS3) {
      logError("textract.s3_bucket_missing_fallback", new Error("S3 bucket missing"), {
        detail:
          "TEXTRACT_USE_S3=true ですがバケット未設定のため、AnalyzeExpense を Bytes モードへフォールバックします。TEXTRACT_SOURCE_S3_BUCKET（または TEXTRACT_S3_BUCKET / RECEIPT_SOURCE_S3_BUCKET / AWS_S3_BUCKET）を設定してください。",
      });
    }

    const s3Key = effectiveUseS3
      ? `${sourcePrefix || DEFAULT_S3_PREFIX}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${crypto
          .randomBytes(6)
          .toString("hex")}.bin`
      : null;

    if (effectiveUseS3 && s3Client && s3Key) {
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: sourceBucket,
            Key: s3Key,
            Body: imageBytes,
            ContentType: "application/octet-stream",
          }),
        );
      } catch (e) {
        const err = new Error(`Textract入力画像のS3保存に失敗しました: ${String(e?.message ?? e)}`);
        err.code = "TextractS3UploadFailed";
        err.statusCode = 502;
        throw err;
      }
    }

    const s3EnabledByConfig = effectiveUseS3 && Boolean(s3Client);

    const commandForAnalyze = new AnalyzeExpenseCommand(
      s3EnabledByConfig && s3Key
        ? {
            Document: {
              S3Object: { Bucket: sourceBucket, Name: s3Key },
            },
          }
        : {
            Document: { Bytes: new Uint8Array(imageBytes) },
          },
    );

    let response;
    try {
      for (let attempt = 1; attempt <= sendRetries + 1; attempt += 1) {
        try {
          response = await client.send(commandForAnalyze, {
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
    } finally {
      if (s3EnabledByConfig && s3Client && s3Key) {
        try {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: sourceBucket,
              Key: s3Key,
            }),
          );
        } catch (e) {
          logError("textract.s3_cleanup_failed", e, { key: s3Key });
        }
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

    // 複数候補がある場合は SummaryFields が最も充実した候補を優先
    const doc = [...docs].sort((a, b) => {
      const aFields = Array.isArray(a?.SummaryFields) ? a.SummaryFields.length : 0;
      const bFields = Array.isArray(b?.SummaryFields) ? b.SummaryFields.length : 0;
      if (bFields !== aFields) return bFields - aFields;
      return Number(b?.ExpenseIndex ?? 0) - Number(a?.ExpenseIndex ?? 0);
    })[0];
    const summary = summaryFromFields(doc.SummaryFields);
    let items = lineItemsFromExpenseDoc(doc);
    items = dedupeJunkSymbolDuplicateLineItems(items);
    items = filterSummaryFooterLineItems(items);
    const ocrTextBlocks = collectOcrTextBlocksFromExpenseDoc(doc);
    const ocrLines = ocrTextBlocks.map((x) => x.text).slice(0, 180);
    let notice = null;
    let totalAmount = summary.totalAmount;
    let fieldConfidence = { ...summary.fieldConfidence };
    const ocrSubTax = extractSubtotalTaxFromOcrLines(ocrLines);
    if (ocrSubTax.subtotal != null && ocrSubTax.tax != null) {
      const nextTot = reconcileTotalDoubleTaxError(totalAmount, ocrSubTax.subtotal, ocrSubTax.tax);
      if (nextTot !== totalAmount) {
        totalAmount = nextTot;
        fieldConfidence = { ...fieldConfidence, totalAmount: null };
        notice =
          (notice ? `${notice} ` : "") +
          "OCR 上の小計・税額と照らし、二重に税を足した合計候補を修正しました。";
      }
    }
    const lineSumForCheck = fallbackTotalFromLineItems(items);
    const currentTotalN = Number(totalAmount);
    if (
      Number.isFinite(currentTotalN) &&
      currentTotalN > 0 &&
      Number.isFinite(lineSumForCheck) &&
      lineSumForCheck > 0
    ) {
      const ratio = currentTotalN / lineSumForCheck;
      if (ratio >= 1.8 || ratio <= 0.45) {
        const byOcrLine = fallbackTotalFromOcrLines(ocrLines, lineSumForCheck);
        if (byOcrLine != null) {
          const diffNow = Math.abs(currentTotalN - lineSumForCheck);
          const diffCandidate = Math.abs(byOcrLine - lineSumForCheck);
          // 明細にノイズが混ざり lineSum が異常に大きいとき、Textract 合計に近い OCR 合計を優先する
          const diffVsCurrent = Math.abs(byOcrLine - currentTotalN);
          const preferOcrTotalNearTyped =
            diffVsCurrent < diffCandidate &&
            diffVsCurrent <= Math.max(2500, currentTotalN * 0.12);
          if (diffCandidate + 1 < diffNow || preferOcrTotalNearTyped) {
            totalAmount = byOcrLine;
            fieldConfidence = { ...fieldConfidence, totalAmount: null };
            notice =
              "合計候補の整合性を再評価し、OCR 行からより自然な金額を採用しました。必要に応じて修正してください。";
          }
        }
      }
    }
    if (totalAmount == null) {
      const byOcrLine = fallbackTotalFromOcrLines(ocrLines, lineSumForCheck);
      if (byOcrLine != null) {
        totalAmount = byOcrLine;
        fieldConfidence = { ...fieldConfidence, totalAmount: null };
        notice =
          "合計欄の型付き抽出に失敗したため、OCR 行から合計候補を推定しました。必要に応じて修正してください。";
      } else {
        const fb = fallbackTotalFromLineItems(items);
        if (fb != null) {
          totalAmount = fb;
          fieldConfidence = { ...fieldConfidence, totalAmount: null };
          notice =
            "合計欄を自動検出できなかったため、明細行の金額を合算して推定しました。必要に応じて修正してください。";
        }
      }
    }
    let dateVal = summary.date;
    if (!dateVal) {
      dateVal = fallbackDateFromLineItems(items);
      if (dateVal) {
        fieldConfidence = { ...fieldConfidence, date: fieldConfidence.date ?? null };
      }
    }
    if (!dateVal) {
      for (const d of docs) {
        const fb = fallbackDateFromSummaryFields(d?.SummaryFields);
        if (fb) {
          dateVal = fb;
          fieldConfidence = { ...fieldConfidence, date: fieldConfidence.date ?? null };
          break;
        }
      }
    }
    if (totalAmount != null) {
      const corr = applyOcrDoubleTaxTotalCorrection(totalAmount, ocrLines);
      if (corr != null && Math.abs(corr - Number(totalAmount)) >= 1) {
        totalAmount = corr;
        fieldConfidence = { ...fieldConfidence, totalAmount: fieldConfidence.totalAmount ?? null };
        notice =
          (notice ? `${notice} ` : "") +
          "合計と税額の OCR 表記から税込合計を再確認しました。";
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
      ocrLines,
      ocrTextBlocks,
      textractRaw: {
        expenseIndex: doc.ExpenseIndex ?? null,
        summaryFields: Array.isArray(doc?.SummaryFields)
          ? doc.SummaryFields.map((f) => ({
              type: fieldType(f),
              label: fieldLabel(f),
              text: fieldText(f),
              confidence: fieldConfidence01(f),
            }))
          : [],
      },
      notice,
      expenseIndex: doc.ExpenseIndex ?? null,
    };
  };
}

const defaultAnalyzer = createReceiptAnalyzer();

/**
 * Bedrock ハイブリッド後など、最終合計に対しても小計+税の二重計上を OCR から矯正する。
 * 小計ブロックが欠けても税額だけ取れた場合は「合計行の正額 + 税 = 誤合計」のパターンを直す。
 * @param {unknown} totalAmount
 * @param {string[] | undefined} ocrLines
 * @returns {number | null}
 */
export function applyOcrDoubleTaxTotalCorrection(totalAmount, ocrLines) {
  if (totalAmount == null || totalAmount === "") return null;
  let v = Math.round(Number(totalAmount) * 100) / 100;
  if (!Number.isFinite(v) || v <= 0) return null;
  const ocr = Array.isArray(ocrLines) ? ocrLines : [];
  const pair = extractSubtotalTaxFromOcrLines(ocr);
  if (pair.subtotal != null && pair.tax != null) {
    const d = reconcileTotalDoubleTaxError(v, pair.subtotal, pair.tax);
    if (typeof d === "number" && Number.isFinite(d)) v = d;
  }
  if (pair.tax != null) {
    const g = reconcileIfTotalEqualsGrandPlusTaxOnce(v, pair.tax, ocr);
    if (typeof g === "number" && Number.isFinite(g)) v = g;
  }
  return Math.round(v * 100) / 100;
}

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
