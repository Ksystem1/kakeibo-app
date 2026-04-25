/**
 * ランディング「デモダッシュボード」専用の静的データ。API / DB には使いません。
 */
export const DEMO_MEDICAL_YEAR = 2026;
export const DEMO_MEDICAL_TOTAL_YEN = 120_000;
export const DEMO_MEDICAL_TX_COUNT = 12;

export type DemoMedicalMatrixRow = {
  name: string;
  treatment: number;
  medicine: number;
  other: number;
};

export const demoMedicalMatrixRows: DemoMedicalMatrixRow[] = [
  { name: "本人", treatment: 28_000, medicine: 12_000, other: 5_000 },
  { name: "配偶者", treatment: 27_000, medicine: 16_000, other: 9_000 },
  { name: "子", treatment: 13_000, medicine: 7_000, other: 3_000 },
];

export type DemoSpendingChartDatum = {
  name: string;
  value: number;
  color: string;
};

export type DemoRecentTransaction = {
  id: number;
  category: string;
  title: string;
  amount: number;
  time: string;
};

/** カテゴリ別（固定費を大きく見せる） */
export const demoBaseSpendingForChart: DemoSpendingChartDatum[] = [
  { name: "固定費（毎月自動）", value: 48_000, color: "#6366f1" },
  { name: "食費", value: 32_000, color: "#22c55e" },
  { name: "光熱費", value: 12_000, color: "#86efac" },
  { name: "交通費", value: 9_000, color: "#fb923c" },
  { name: "日用品", value: 11_000, color: "#fbbf24" },
  { name: "その他", value: 12_000, color: "#a78bfa" },
];

export const demoRecentForHero: DemoRecentTransaction[] = [
  { id: 1, category: "食費", title: "スーパー（おまかせ取込）", amount: 1_280, time: "今日 18:45" },
  { id: 2, category: "光熱費", title: "電気料金（固定費）", amount: 6_380, time: "昨日 09:10" },
  { id: 3, category: "日用品", title: "PayPay ドラッグストア", amount: 980, time: "2/3 20:12" },
];

/** クレカ・PayPay 取込後のイメージ明細（デモダッシュボード Step1 専用） */
export const demoImportIdealRecent: DemoRecentTransaction[] = [
  { id: 1, category: "食費", title: "JCB: 生鮮スーパー 〇〇", amount: 1_280, time: "今日 18:12" },
  { id: 2, category: "外食", title: "PayPay支払い：社食ランチ", amount: 650, time: "今日 12:20" },
  { id: 3, category: "日用品", title: "VISA: ドラッグストア", amount: 980, time: "昨日 20:15" },
  { id: 4, category: "交通", title: "VISA: ＩＣチャージ", amount: 2_000, time: "昨日 8:00" },
  { id: 5, category: "雑費", title: "PayPay支払い：コンビニ", amount: 320, time: "2/3 21:30" },
];

export const demoTypingInputs: { category: string; amount: number; title: string }[] = [
  { category: "食費", amount: 1200, title: "コンビニ" },
  { category: "日用品", amount: 980, title: "ドラッグストア" },
  { category: "光熱費", amount: 2200, title: "プロパン明細" },
];

/** 銀行・カード・PayPay 一括取込イメージ（ステップ2） */
export type DemoImportPreviewRow = {
  id: string;
  source: string;
  date: string;
  description: string;
  amount: number;
  category: string;
};

export const demoImportPreviewRows: DemoImportPreviewRow[] = [
  { id: "1", source: "武蔵野銀行", date: "2026/02/14", description: "フードスクエア", amount: 3980, category: "食費" },
  { id: "2", source: "エポスカード", date: "2026/02/15", description: "マツモトキヨシ", amount: 1680, category: "日用品" },
  { id: "3", source: "PayPay", date: "2026/02/15", description: "PayPay支払い：セブンイレブン", amount: 485, category: "食費" },
  { id: "4", source: "武蔵野銀行", date: "2026/02/16", description: "〇〇クリニック", amount: 3600, category: "医療" },
  { id: "5", source: "エポスカード", date: "2026/02/17", description: "AMAZON.CO.JP", amount: 1750, category: "日用品" },
];
