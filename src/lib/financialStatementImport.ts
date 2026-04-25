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

let pdfWorkerConfigured = false;
function ensurePdfWorkerConfigured() {
  if (pdfWorkerConfigured) return;
  const g = (pdfjs as unknown as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions;
  if (g) g.workerSrc = workerSrc;
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

const DATE_RE = /\b(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/;
const AMOUNT_RE = /([+-]?\d[\d,]*(?:\.\d+)?)(?:\s*円)?/;
const MEDICAL_HINT_RE =
  /病院|医院|クリニック|薬局|調剤|歯科|眼科|内科|外科|整形|皮膚科|耳鼻科|小児科|産婦人|医療|処方|ドラッグ/i;

function normalizeDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m1 = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`;
  const m2 = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!m2) return null;
  const year = m2[3].length === 2 ? 2000 + Number(m2[3]) : Number(m2[3]);
  if (!Number.isFinite(year)) return null;
  return `${String(year).padStart(4, "0")}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
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

function inferHeaderIndices(header: string[]): HeaderIndices | null {
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

export function parseFinancialCsvText(csvText: string, sourceLabel = "CSV"): ImportedStatementRow[] {
  const lines = String(csvText ?? "").split(/\r?\n/);
  if (lines.length < 2) return [];

  const rows = lines.map(parseCsvLine).filter((cells) => cells.some((c) => String(c ?? "").trim() !== ""));
  let headerRowIdx = -1;
  let indices: HeaderIndices | null = null;
  for (let i = 0; i < Math.min(80, rows.length); i++) {
    const h = rows[i];
    const found = inferHeaderIndices(h);
    if (found) {
      headerRowIdx = i;
      indices = found;
      break;
    }
  }
  if (!indices || headerRowIdx < 0) return [];

  const out: ImportedStatementRow[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const cells = rows[i];
    const date = normalizeDate(cells[indices.iDate] ?? "");
    const amount = pickExpenseAmount(cells, indices);
    const description = combineDescription(cells, indices);
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
  return out;
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
    const doc = await pdfjs.getDocument({ data }).promise;
  const out: ImportedStatementRow[] = [];

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
          description: parsed.description,
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
