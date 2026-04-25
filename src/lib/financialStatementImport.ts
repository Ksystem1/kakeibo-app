import { parseCsvLine } from "./csvLine";

export type ImportedStatementRow = {
  id: string;
  date: string;
  description: string;
  amount: number;
  source: string;
  categoryGuess: string;
  medicalAuto: boolean;
};

type HeaderAlias = {
  date: string[];
  description: string[];
  amount: string[];
};

const KNOWN_HEADER_PATTERNS: HeaderAlias[] = [
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
    date: ["利用日", "利用年月日", "売上日", "確定日", "利用日付"],
    description: ["利用店名・商品名", "ご利用店名", "加盟店名", "内容"],
    amount: ["利用金額", "お支払い金額", "請求額", "利用額"],
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
  return String(h ?? "").trim().toLowerCase();
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

function inferHeaderIndices(header: string[]): { iDate: number; iDesc: number; iAmt: number } | null {
  for (const p of KNOWN_HEADER_PATTERNS) {
    const iDate = findByAliases(header, p.date);
    const iDesc = findByAliases(header, p.description);
    const iAmt = findByAliases(header, p.amount);
    if (iDate >= 0 && iAmt >= 0) return { iDate, iDesc, iAmt };
  }

  // フォールバック推定
  const iDate = findByAliases(header, ["日付", "利用日", "取引", "年月日"]);
  const iDesc = findByAliases(header, ["内容", "摘要", "利用先", "店", "加盟店", "相手"]);
  const iAmt = findByAliases(header, ["金額", "支払", "引落", "利用", "請求", "出金"]);
  if (iDate >= 0 && iAmt >= 0) return { iDate, iDesc, iAmt };
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

export function parseFinancialCsvText(csvText: string, sourceLabel = "CSV"): ImportedStatementRow[] {
  const lines = String(csvText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const rows = lines.map(parseCsvLine);
  let headerRowIdx = -1;
  let indices: { iDate: number; iDesc: number; iAmt: number } | null = null;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
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
    const amount = parseAmount(cells[indices.iAmt] ?? "");
    const description = String(cells[indices.iDesc] ?? "").trim() || "明細";
    if (!date || amount == null) continue;
    out.push({
      id: toRowId(sourceLabel, i),
      date,
      amount,
      description,
      source: sourceLabel,
      categoryGuess: guessCategory(description),
      medicalAuto: MEDICAL_HINT_RE.test(description),
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
  const data = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await import("pdfjs-dist");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  (pdfjs as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions = {
    workerSrc,
  };
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: ImportedStatementRow[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
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
  }
  return out;
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
