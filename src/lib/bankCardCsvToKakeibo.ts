import { parseCsvLine } from "./csvLine";

const DATE_HEADER = /利用日|取引日|お取引日|日付|利用日時|取引日時|勘定日|決済日/i;
const AMOUNT_HEADER =
  /出金|出金額|出金金額|お支払|支払|利用金額|金額(?!.*取引)|引落|ご利用金額/i;
const WITHDRAW_ONLY = /出金|引落|お支払|支払金額|ご利用金額(?!.*残高)/i;
const MEMO_HEADER = /お取引内容|取引内容|摘要|解説|店|相手先|利用先|加盟店|内容|コメント|取引先|御利用/i;

function normalizeDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m1 = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (m1) {
    const y = m1[1];
    const mo = m1[2].padStart(2, "0");
    const d = m1[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  const m2 = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m2) {
    let y = m2[3].length === 2 ? 2000 + Number(m2[3]) : Number(m2[3]);
    if (!Number.isFinite(y) || y < 1990) y = new Date().getFullYear();
    const mo = m2[1].padStart(2, "0");
    const d = m2[2].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return null;
}

function parseAmountCell(raw: string): number | null {
  const t = String(raw ?? "").replace(/[,円\s]/g, "").replace(/[−–ー]/g, "-");
  if (!t) return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n));
}

function isKakeiboRow(parts: string[]): boolean {
  if (parts.length < 3) return false;
  const d = parts[1].replace(/\//g, "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const amount = Number.parseFloat(String(parts[2]).replace(/[,円]/g, ""));
  return Number.isFinite(amount);
}

function looksLikeKakeiboManual(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return false;
  let ok = 0;
  let n = 0;
  for (const line of lines) {
    const p = parseCsvLine(line);
    if (p.length < 3 || p.every((c) => c === "")) continue;
    n++;
    if (isKakeiboRow(p)) ok++;
  }
  return n > 0 && ok / n >= 0.5;
}

function findHeaderRow(rows: string[][]): { header: string[]; dataStart: number } | null {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i];
    if (!cells?.length) continue;
    const line = cells.join(" ");
    if (cells[0] === "カテゴリ" || /^カテゴリ[,\t]/.test(line)) {
      continue;
    }
    const looksBankish = /利用|取引(?!内容)|入金|出金|明細|勘定|お取引|決済/.test(line);
    if (looksBankish && DATE_HEADER.test(line) && (AMOUNT_HEADER.test(line) || /金額/.test(line))) {
      return { header: rows[i], dataStart: i + 1 };
    }
  }
  return null;
}

function colIndex(header: string[], re: RegExp): number {
  return header.findIndex((h) => re.test(String(h).trim()));
}

function inferPaymentLabel(raw: string, header: string[]): string | null {
  const blob = `${String(raw ?? "")} ${header.join(" ")}`.normalize("NFKC").toLowerCase();
  if (/paypay|ペイペイ/.test(blob)) return "PayPay支払い";
  if (/d払い|d barai|dbarai|docomo/.test(blob)) return "d払い";
  if (/メルペイ|merpay/.test(blob)) return "メルペイ払い";
  if (/楽天ペイ|rakuten ?pay/.test(blob)) return "楽天ペイ払い";
  if (/au ?pay|ａｕ ?ｐａｙ/.test(blob)) return "au PAY払い";
  if (/クレジット|カード|visa|master|jcb|amex|diners|信販/.test(blob)) return "クレジット払い";
  if (/銀行|信用金庫|信金|口座|引落/.test(blob)) return "口座引落";
  return null;
}

/**
 * 銀行・カード会社の明細っぽい CSV を、既存 `POST /import/csv` が解釈する
 * `カテゴリ,YYYY-MM-DD,金額,メモ` 形式に変換（推測。判別不能なら null）。
 */
function escapeField(s: string): string {
  const v = String(s ?? "");
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * PayPay 公式等からの履歴 CSV。銀行取込用の自動変換はせず /receipt へ回す。
 */
export function looksLikePayPayCsv(text: string): boolean {
  const raw = String(text ?? "");
  const first = raw.split(/\r?\n/).find((x) => x.trim()) ?? "";
  const headerCols = parseCsvLine(first).map((x) => String(x ?? "").trim());
  const isOfficialPayPayHeader =
    headerCols.includes("取引日") &&
    (headerCols.includes("出金金額（円）") || headerCols.includes("出金金額(円)")) &&
    headerCols.includes("取引内容") &&
    headerCols.includes("取引先") &&
    headerCols.includes("取引番号");
  if (isOfficialPayPayHeader) return true;

  if (!/PayPay/i.test(raw) && !/ﾍﾟｲﾍﾟｲ|ペイペイ|ＰＡＹＰＡＹ/.test(raw)) {
    // ヘッダーなし: 取引番号,日付,金額,...,PAYPAY
    const cols = parseCsvLine(first);
    const looksDate = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(String(cols[1] ?? "").trim());
    const looksAmount = /^\d[\d,]*$/.test(String(cols[2] ?? "").trim());
    const hasPaypayWord = /paypay|ＰＡＹＰＡＹ|ペイペイ/i.test(first);
    if (!(cols.length >= 3 && looksDate && looksAmount && hasPaypayWord)) return false;
  }
  if (/(クレジット|カード).*(利用|明細|履歴|CSV)/.test(raw)) return false;
  const head = raw.slice(0, 4_000);
  if (/PayPay支払い[:：]/.test(head) || /PayPay.*(利用|入金|出金)/.test(head)) return true;
  if (/^[^,\r\n]+,.*PayPay/i.test(head.split(/\r?\n/)[0] ?? "")) return true;
  const firstRows = head.split(/\r?\n/).slice(0, 5).map(parseCsvLine);
  const joined = firstRows.map((r) => r.join(" ")).join(" ");
  if (/取引(日|番号|ID)|利用日|支払(日|先)?/.test(joined) && /(店舗|利用先|相手|内容)/.test(joined))
    return /PayPay|ペイ/.test(joined);
  return false;
}

export function tryConvertBankCardCsvToKakeibo(
  text: string,
): { text: string; message: string } | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (looksLikeKakeiboManual(raw)) return null;

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const rows = lines.map(parseCsvLine);
  if (rows.some((r) => r.length < 2)) return null;

  const found = findHeaderRow(rows);
  if (!found) return null;

  const { header, dataStart } = found;
  const paymentLabel = inferPaymentLabel(raw, header);
  const iDate = colIndex(header, DATE_HEADER);
  let iAmt = colIndex(header, WITHDRAW_ONLY);
  if (iAmt < 0) iAmt = colIndex(header, AMOUNT_HEADER);
  const iMemo = colIndex(header, MEMO_HEADER);

  if (iDate < 0 || iAmt < 0) return null;

  const out: string[] = [];
  const defaultCategory = "未分類";
  const needMax = Math.max(iDate, iAmt, iMemo, 0);
  for (let r = dataStart; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.every((c) => c === "")) continue;
    if (cells.length < needMax + 1) continue;
    const dRaw = cells[iDate] ?? "";
    const date = normalizeDate(dRaw);
    if (!date) continue;
    const amt = parseAmountCell(cells[iAmt] ?? "");
    if (amt == null || amt <= 0) continue;
    const memoRaw = iMemo >= 0 ? String(cells[iMemo] ?? "").replace(/\r?\n/g, " ").trim() : "";
    const memo = memoRaw
      ? paymentLabel
        ? `${paymentLabel}: ${memoRaw}`.slice(0, 500)
        : memoRaw
      : paymentLabel ?? "";
    out.push(
      [defaultCategory, date, String(amt), escapeField(memo)].join(",")
    );
  }
  if (out.length === 0) return null;
  return {
    text: out.join("\n"),
    message: `金融機関・カード明細風の列名を検出し、家計簿用（${out.length}行）に変換して取り込みました。`,
  };
}
