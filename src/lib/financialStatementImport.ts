import { parseCsvLine } from "./csvLine";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export type ImportedStatementRow = {
  id: string;
  date: string;
  description: string;
  amount: number;
  source: string;
  categoryGuess: string;
  medicalAuto: boolean;
};

export type FinancialCsvParseResult = {
  rows: ImportedStatementRow[];
  needsManualMapping: boolean;
  message?: string;
  detected?: {
    dateCol: number;
    amountCol: number;
    descriptionCol: number;
    dataStartRow: number;
  };
};

let pdfWorkerConfigured = false;
function ensurePdfWorkerConfigured() {
  if (pdfWorkerConfigured) return;
  const g = (pdfjs as unknown as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions;
  if (g && g.workerSrc !== workerSrc) g.workerSrc = workerSrc;
  pdfWorkerConfigured = true;
}

type HeaderAlias = {
  date: string[];
  description: string[];
  descriptionSecondary?: string[];
  expenseAmount?: string[];
  incomeAmount?: string[];
  amount: string[];
};

const KNOWN_HEADER_PATTERNS: HeaderAlias[] = [
  {
    // PayPay
    date: ["取引日", "日時", "利用日"],
    description: ["取引先", "支払先", "加盟店", "内容"],
    descriptionSecondary: ["取引内容", "種別", "取引種別"],
    amount: ["取引金額", "支払金額", "金額", "利用金額"],
  },
  {
    // 三井住友銀行（Web明細）
    date: ["年月日", "取引日", "お取引日"],
    description: ["お取り扱い内容", "摘要", "取引内容", "内容"],
    expenseAmount: ["お引出し", "出金", "引落"],
    incomeAmount: ["お預入れ", "入金"],
    amount: ["金額", "お引出し", "出金金額", "お支払額"],
  },
  {
    // 三菱UFJ / みずほ / 地銀系
    date: ["取引日", "お取引日", "日付", "起算日", "利用日"],
    description: ["摘要", "取引内容", "内容", "利用店名", "加盟店"],
    amount: ["出金金額", "支払金額", "引落金額", "利用金額", "金額"],
  },
  {
    // SMBC / 楽天銀行 / 信金系
    date: ["取引日時", "利用日時", "伝票日付", "処理日", "ご利用日"],
    description: ["明細", "お取引内容", "相手先", "支払先", "ご利用先"],
    amount: ["お支払額", "お支払金額", "請求額", "Debit", "出金"],
  },
  {
    // エポス / VISA / Mastercard
    date: ["利用日", "利用年月日", "売上日", "確定日", "利用日付", "ご利用年月日"],
    description: ["利用店名・商品名", "ご利用店名", "加盟店名", "内容", "ご利用場所"],
    amount: ["利用金額", "お支払い金額", "請求額", "利用額", "ご利用金額"],
  },
];

const DATE_RE = /\b(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{8}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/;
const AMOUNT_RE = /([+-]?\d[\d,]*(?:\.\d+)?)(?:\s*円)?/;
const MEDICAL_HINT_RE =
  /病院|医院|クリニック|薬局|調剤|歯科|眼科|内科|外科|整形|皮膚科|耳鼻科|小児科|産婦人|医療|処方|ドラッグ/i;
const DESCRIPTION_HEADER_RE = /摘要|内容|店|店舗|利用先|支払先|加盟店|取引先|ご利用場所|お取り扱い内容|備考|明細/i;
const EXPENSE_HEADER_RE = /お引出し|出金|引落|支払|請求|利用金額|ご利用金額|debit/i;
const INCOME_HEADER_RE = /お預入れ|入金|credit/i;
const DATE_HEADER_RE = /利用日|年月日|取引日|日付|date|ご利用年月日|伝票日付/i;
const AMOUNT_HEADER_GENERIC_RE = /利用金額|金額|お引出し|お預入れ|支払金額|amount|請求額|出金/i;
const NON_DATA_HEADER_RE = /^no$|^no\.$|番号|連番|空白|blank/i;
const IGNORE_PREAMBLE_RE = /月別ご利用明細|カードご利用明細|種別|お支払明細|ご利用期間|お支払開始月/i;
const IGNORE_NOTE_RE = /^※\d*|注[記釈]|備考|但し/i;
const IGNORE_TOTAL_RE = /ショッピング合計|キャッシング合計|ご利用合計|当月合計|総合計|合計|振替予定/i;

function ensurePaymentPrefix(description: string, paymentLabel: string | null): string {
  const d = String(description ?? "").trim();
  if (!d) return d;
  const p = String(paymentLabel ?? "").trim();
  if (!p) return d;
  if (d.startsWith(`${p}:`) || d.startsWith(`${p}：`) || d.startsWith(p)) return d;
  return `${p}: ${d}`.slice(0, 500);
}

function inferStatementPaymentLabel(sourceLabel: string, headerCells: string[]): string | null {
  const src = String(sourceLabel ?? "").normalize("NFKC").toLowerCase();
  const hdr = headerCells.map((x) => String(x ?? "")).join(" ").normalize("NFKC").toLowerCase();
  const blob = `${src} ${hdr}`;
  if (/paypay|ペイペイ/.test(blob)) return "PayPay支払い";
  if (/d払い|d barai|dbarai|docomo/.test(blob)) return "d払い";
  if (/メルペイ|merpay/.test(blob)) return "メルペイ払い";
  if (/楽天ペイ|rakuten ?pay/.test(blob)) return "楽天ペイ払い";
  if (/au ?pay|ａｕ ?ｐａｙ/.test(blob)) return "au PAY払い";
  if (/クレジット|カード|visa|master|jcb|amex|diners|信販/.test(blob)) return "クレジット払い";
  if (/銀行|信用金庫|信金|農協|jaバンク|ゆうちょ|口座|引落/.test(blob)) return "口座引落";
  return null;
}

function normalizeDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const mYearKanji = s.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/);
  if (mYearKanji) {
    return `${mYearKanji[1]}-${mYearKanji[2].padStart(2, "0")}-${mYearKanji[3].padStart(2, "0")}`;
  }
  const m0 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m0) return `${m0[1]}-${m0[2]}-${m0[3]}`;
  const m1 = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`;
  const m2 = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!m2) return null;
  const year = m2[3].length === 2 ? 2000 + Number(m2[3]) : Number(m2[3]);
  if (!Number.isFinite(year)) return null;
  return `${String(year).padStart(4, "0")}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
}

function extractNormalizedDate(raw: string): string | null {
  const direct = normalizeDate(raw);
  if (direct) return direct;
  const m = String(raw ?? "").match(DATE_RE);
  if (!m) return null;
  return normalizeDate(m[1]);
}

function parseAmount(raw: string): number | null {
  const t = String(raw ?? "").replace(/[円,\s]/g, "").replace(/[−–ー]/g, "-");
  if (!t) return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  const y = Math.round(Math.abs(n));
  return y > 0 ? y : null;
}

function normalizeHeaderCell(h: string): string {
  return String(h ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[()（）・:：]/g, "")
    .trim()
    .toLowerCase();
}

function findByAliases(header: string[], aliases: string[]): number {
  const hs = header.map(normalizeHeaderCell);
  for (let i = 0; i < hs.length; i++) {
    const cell = hs[i];
    if (!cell) continue;
    if (aliases.some((a) => cell.includes(String(a).trim().toLowerCase()))) return i;
  }
  return -1;
}

type HeaderIndices = {
  iDate: number;
  iDesc: number;
  iDesc2: number;
  iAmt: number;
  iExpenseAmt: number;
  iIncomeAmt: number;
};

type DynamicIndices = HeaderIndices & {
  dataStart: number;
};

function inferHeaderIndices(header: string[]): HeaderIndices | null {
  const normalized = header.map(normalizeHeaderCell);
  // PayPay公式CSV: 取引先を内容欄の主情報にし、取引内容は補助情報として扱う。
  const iPayPayDate = findByAliases(header, ["取引日"]);
  const iPayPayOut = findByAliases(header, ["出金金額（円）", "出金金額(円)"]);
  const iPayPayMerchant = findByAliases(header, ["取引先"]);
  const iPayPayContent = findByAliases(header, ["取引内容"]);
  if (iPayPayDate >= 0 && iPayPayOut >= 0 && iPayPayMerchant >= 0) {
    return {
      iDate: iPayPayDate,
      iDesc: iPayPayMerchant,
      iDesc2: iPayPayContent,
      iAmt: iPayPayOut,
      iExpenseAmt: iPayPayOut,
      iIncomeAmt: findByAliases(header, ["入金金額（円）", "入金金額(円)"]),
    };
  }

  const iDateGeneric = normalized.findIndex((h) => DATE_HEADER_RE.test(h));
  const iDescGeneric = normalized.findIndex((h) => DESCRIPTION_HEADER_RE.test(h));
  const iAmtGeneric = normalized.findIndex((h) => AMOUNT_HEADER_GENERIC_RE.test(h));
  if (iDateGeneric >= 0 && iAmtGeneric >= 0) {
    const iExpenseAmt = normalized.findIndex((h) => EXPENSE_HEADER_RE.test(h));
    const iIncomeAmt = normalized.findIndex((h) => INCOME_HEADER_RE.test(h));
    return {
      iDate: iDateGeneric,
      iDesc: iDescGeneric,
      iDesc2: -1,
      iAmt: iAmtGeneric,
      iExpenseAmt,
      iIncomeAmt,
    };
  }

  for (const p of KNOWN_HEADER_PATTERNS) {
    const iDate = findByAliases(header, p.date);
    const iDesc = findByAliases(header, p.description);
    const iDesc2 = findByAliases(header, p.descriptionSecondary ?? []);
    const iExpenseAmt = findByAliases(header, p.expenseAmount ?? []);
    const iIncomeAmt = findByAliases(header, p.incomeAmount ?? []);
    const iAmt = findByAliases(header, p.amount);
    if (iDate >= 0 && (iAmt >= 0 || iExpenseAmt >= 0)) {
      return { iDate, iDesc, iDesc2, iAmt, iExpenseAmt, iIncomeAmt };
    }
  }

  // フォールバック推定
  const iDate = findByAliases(header, ["日付", "利用日", "取引", "年月日"]);
  const iDesc = findByAliases(header, ["内容", "摘要", "利用先", "店", "加盟店", "相手", "場所"]);
  const iDesc2 = findByAliases(header, ["取引内容", "種別", "備考", "メモ"]);
  const iExpenseAmt = findByAliases(header, ["お引出し", "出金", "引落", "支払", "請求"]);
  const iIncomeAmt = findByAliases(header, ["お預入れ", "入金"]);
  const iAmt = findByAliases(header, ["金額", "支払", "引落", "利用", "請求", "出金"]);
  if (iDate >= 0 && (iAmt >= 0 || iExpenseAmt >= 0)) {
    return { iDate, iDesc, iDesc2, iAmt, iExpenseAmt, iIncomeAmt };
  }
  return null;
}

function hasDateCell(cells: string[]): boolean {
  return cells.some((c) => extractNormalizedDate(c) != null);
}

function firstDateRowIndex(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 160); i++) {
    if (isIgnorablePreambleRow(rows[i])) continue;
    if (hasDateCell(rows[i])) return i;
  }
  return -1;
}

function rowJoined(cells: string[]): string {
  return cells.map((c) => String(c ?? "").trim()).filter(Boolean).join(" ");
}

function isIgnorablePreambleRow(cells: string[]): boolean {
  const joined = rowJoined(cells);
  if (!joined) return true;
  if (IGNORE_PREAMBLE_RE.test(joined) && !hasDateCell(cells)) return true;
  if (IGNORE_NOTE_RE.test(joined) && !hasDateCell(cells)) return true;
  return false;
}

function isIgnorableDataRow(cells: string[]): boolean {
  const joined = rowJoined(cells);
  if (!joined) return true;
  if (IGNORE_NOTE_RE.test(joined)) return true;
  if (IGNORE_TOTAL_RE.test(joined) && !hasDateCell(cells)) return true;
  if (!hasDateCell(cells) && /^(小計|総計|合算)/.test(joined)) return true;
  return false;
}

function countTextRichChars(v: string): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  return (s.match(/[ぁ-んァ-ヶ一-龯A-Za-z]/g) ?? []).length;
}

function inferIndicesFromData(rows: string[][], startRow: number): DynamicIndices | null {
  let iDate = -1;
  let iAmt = -1;
  let iExpenseAmt = -1;
  let iIncomeAmt = -1;
  let iDesc = -1;

  let headerCandidate = startRow > 0 ? rows[startRow - 1] ?? [] : [];
  if (!headerCandidate.some((c) => String(c ?? "").trim())) headerCandidate = [];

  if (headerCandidate.length > 0) {
    iDate = findByAliases(headerCandidate, ["利用日", "年月日", "取引日", "日付", "date", "ご利用年月日"]);
    iDesc = findByAliases(headerCandidate, ["ご利用場所", "加盟店", "摘要", "店名", "内容", "取引先", "利用店", "支払先", "備考"]);
    iExpenseAmt = findByAliases(headerCandidate, ["お引出し", "出金", "引落", "支払金額", "利用金額", "ご利用金額"]);
    iIncomeAmt = findByAliases(headerCandidate, ["お預入れ", "入金"]);
    iAmt = findByAliases(headerCandidate, ["利用金額", "金額", "お引出し", "お預入れ", "支払金額", "amount"]);
  }

  const sampleRows = rows.slice(startRow, Math.min(rows.length, startRow + 40));
  const maxCols = sampleRows.reduce((m, r) => Math.max(m, r.length), 0);

  if (iDate < 0) {
    for (let c = 0; c < maxCols; c++) {
      const hits = sampleRows.filter((row) => normalizeDate(row[c] ?? "") != null).length;
      if (hits >= 1) {
        iDate = c;
        break;
      }
    }
  }
  if (iDate < 0) return null;

  if (iExpenseAmt < 0 || iIncomeAmt < 0 || iAmt < 0 || iDesc < 0) {
    let bestAmountCol = -1;
    let bestAmountScore = -1;
    let bestDescCol = -1;
    let bestDescScore = -1;
    for (let c = 0; c < maxCols; c++) {
      if (c === iDate) continue;
      const headerCell = normalizeHeaderCell(headerCandidate[c] ?? "");
      if (NON_DATA_HEADER_RE.test(headerCell)) continue;
      const numericHits = sampleRows.filter((row) => parseAmount(row[c] ?? "") != null).length;
      const textScore = sampleRows.reduce((acc, row) => acc + countTextRichChars(row[c] ?? ""), 0);
      const descHeaderBoost = DESCRIPTION_HEADER_RE.test(headerCell) ? 50 : 0;
      const expenseHeaderBoost = EXPENSE_HEADER_RE.test(headerCell) ? 40 : 0;
      const incomeHeaderBoost = INCOME_HEADER_RE.test(headerCell) ? 25 : 0;
      if (expenseHeaderBoost > 0 && iExpenseAmt < 0) iExpenseAmt = c;
      if (incomeHeaderBoost > 0 && iIncomeAmt < 0) iIncomeAmt = c;
      if (numericHits * 10 + expenseHeaderBoost > bestAmountScore) {
        bestAmountScore = numericHits * 10 + expenseHeaderBoost;
        bestAmountCol = c;
      }
      if (textScore + descHeaderBoost > bestDescScore) {
        bestDescScore = textScore + descHeaderBoost;
        bestDescCol = c;
      }
    }
    if (iAmt < 0) iAmt = bestAmountCol;
    if (iDesc < 0) iDesc = bestDescCol;
  }

  if (iAmt < 0 && iExpenseAmt < 0) return null;
  if (iDesc < 0) iDesc = -1;
  return {
    iDate,
    iDesc,
    iDesc2: -1,
    iAmt,
    iExpenseAmt,
    iIncomeAmt,
    dataStart: startRow,
  };
}

function guessCategory(description: string): string {
  const s = description.toLowerCase();
  if (/病院|薬局|クリニック|ドラッグ/.test(s)) return "医療";
  if (/スーパー|コンビニ|レストラン|カフェ|ランチ/.test(s)) return "食費";
  if (/電車|バス|タクシー|高速|駐車|suica|pasmo|ic/.test(s)) return "交通費";
  if (/電気|ガス|水道|携帯|通信|ネット/.test(s)) return "光熱費";
  if (/衣料|アパレル|ユニクロ|しまむら/.test(s)) return "衣類";
  return "未分類";
}

function toRowId(source: string, idx: number): string {
  return `${source}#${idx + 1}`;
}

function normalizeDataCell(v: string): string {
  return String(v ?? "").normalize("NFKC").trim();
}

function pickExpenseAmount(cells: string[], indices: HeaderIndices): number | null {
  const expense = indices.iExpenseAmt >= 0 ? parseAmount(cells[indices.iExpenseAmt] ?? "") : null;
  const income = indices.iIncomeAmt >= 0 ? parseAmount(cells[indices.iIncomeAmt] ?? "") : null;
  if (expense != null && expense > 0) return expense;
  if (income != null && income > 0) return null;
  if (indices.iAmt >= 0) return parseAmount(cells[indices.iAmt] ?? "");
  return null;
}

function combineDescription(cells: string[], indices: HeaderIndices): string {
  const primary = indices.iDesc >= 0 ? normalizeDataCell(cells[indices.iDesc] ?? "") : "";
  const secondary = indices.iDesc2 >= 0 ? normalizeDataCell(cells[indices.iDesc2] ?? "") : "";
  if (primary && secondary && !primary.includes(secondary)) return `${secondary} ${primary}`.trim();
  return primary || secondary || "明細";
}

function inferMedicalType(description: string): "treatment" | "medicine" | null {
  const s = description.toLowerCase();
  if (/薬局|調剤|ドラッグ|マツキヨ|ウエルシア|スギ薬局|ココカラ/.test(s)) return "medicine";
  if (/病院|医院|クリニック|歯科|内科|外科|皮膚科|眼科|耳鼻|小児科|整形/.test(s)) return "treatment";
  return null;
}

export function parseFinancialCsvWithInference(csvText: string, sourceLabel = "CSV"): FinancialCsvParseResult {
  const lines = String(csvText ?? "").split(/\r?\n/);
  if (lines.length < 2) {
    return { rows: [], needsManualMapping: true, message: "データ行が不足しています。" };
  }

  const rows = lines.map(parseCsvLine).filter((cells) => cells.some((c) => String(c ?? "").trim() !== ""));
  let dynamic: DynamicIndices | null = null;
  for (let i = 0; i < Math.min(80, rows.length); i++) {
    const h = rows[i];
    const found = inferHeaderIndices(h);
    if (found) {
      dynamic = { ...found, dataStart: i + 1 };
      break;
    }
  }
  if (!dynamic) {
    // 先頭の口座情報・広告・注釈を飛ばし、最初に日付を含む行から推論する。
    const firstDataRow = firstDateRowIndex(rows);
    if (firstDataRow >= 0) dynamic = inferIndicesFromData(rows, firstDataRow);
  }
  if (!dynamic) {
    return {
      rows: [],
      needsManualMapping: true,
      message: "列を自動判定できませんでした。手動で列を選択してください。",
    };
  }
  const headerLike = dynamic.dataStart > 0 ? rows[dynamic.dataStart - 1] ?? [] : [];
  const paymentLabel = inferStatementPaymentLabel(sourceLabel, headerLike);

  const out: ImportedStatementRow[] = [];
  for (let i = dynamic.dataStart; i < rows.length; i++) {
    const cells = rows[i];
    if (isIgnorableDataRow(cells)) continue;
    const date = extractNormalizedDate(cells[dynamic.iDate] ?? "");
    const amount = pickExpenseAmount(cells, dynamic);
    const description = ensurePaymentPrefix(combineDescription(cells, dynamic), paymentLabel);
    if (!date || amount == null) continue;
    const inferredMedicalType = inferMedicalType(description);
    const medicalAuto = inferredMedicalType != null || MEDICAL_HINT_RE.test(description);
    out.push({
      id: toRowId(sourceLabel, i),
      date,
      amount,
      description,
      source: sourceLabel,
      categoryGuess: guessCategory(description),
      medicalAuto,
    });
  }
  if (out.length === 0) {
    return {
      rows: [],
      needsManualMapping: true,
      message: "明細行を抽出できませんでした。手動で列を選択してください。",
      detected: {
        dateCol: dynamic.iDate,
        amountCol: dynamic.iExpenseAmt >= 0 ? dynamic.iExpenseAmt : dynamic.iAmt,
        descriptionCol: dynamic.iDesc,
        dataStartRow: dynamic.dataStart,
      },
    };
  }
  return {
    rows: out,
    needsManualMapping: false,
    detected: {
      dateCol: dynamic.iDate,
      amountCol: dynamic.iExpenseAmt >= 0 ? dynamic.iExpenseAmt : dynamic.iAmt,
      descriptionCol: dynamic.iDesc,
      dataStartRow: dynamic.dataStart,
    },
  };
}

export function parseFinancialCsvText(csvText: string, sourceLabel = "CSV"): ImportedStatementRow[] {
  return parseFinancialCsvWithInference(csvText, sourceLabel).rows;
}

function parsePdfLine(line: string): { date: string; description: string; amount: number } | null {
  const t = String(line ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const d = t.match(DATE_RE)?.[1] ?? "";
  const date = normalizeDate(d);
  if (!date) return null;
  const a = t.match(AMOUNT_RE)?.[1] ?? "";
  const amount = parseAmount(a);
  if (amount == null) return null;
  let description = t.replace(d, "").replace(a, "").replace(/[|]/g, " ").trim();
  if (!description) description = "PDF明細";
  return { date, description, amount };
}

export async function parseFinancialPdfFile(file: File): Promise<ImportedStatementRow[]> {
  try {
    ensurePdfWorkerConfigured();
    const data = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjs.getDocument({ data });
    const doc = await loadingTask.promise;
    const out: ImportedStatementRow[] = [];

    const paymentLabel = inferStatementPaymentLabel(file.name, []);
    for (let p = 1; p <= doc.numPages; p++) {
      try {
        const page = await doc.getPage(p);
        const text = await page.getTextContent();
        const lines = text.items
          .map((it) => ("str" in it ? String(it.str) : ""))
          .join("\n")
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          const parsed = parsePdfLine(lines[i]);
          if (!parsed) continue;
          out.push({
            id: toRowId(file.name, out.length),
            date: parsed.date,
            description: ensurePaymentPrefix(parsed.description, paymentLabel),
            amount: parsed.amount,
            source: `${file.name} p.${p}`,
            categoryGuess: guessCategory(parsed.description),
            medicalAuto: MEDICAL_HINT_RE.test(parsed.description),
          });
        }
      } catch {
        // 1ページの抽出失敗では全体を落とさない
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function toImportCsvText(rows: ImportedStatementRow[]): string {
  return rows
    .map((r) => {
      const memo = /[",\r\n]/.test(r.description)
        ? `"${r.description.replace(/"/g, '""')}"`
        : r.description;
      return `${r.categoryGuess},${r.date},${r.amount},${memo}`;
    })
    .join("\n");
}

export type DuplicateKey = `${string}|${number}|${string}`;
export function duplicateKey(date: string, amount: number, description: string): DuplicateKey {
  return `${date}|${amount}|${description.trim().toLowerCase()}`;
}
