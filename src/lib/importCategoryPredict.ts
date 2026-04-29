/**
 * 取込プレビュー用カテゴリ候補（学習 → キーワード → 部分一致 → fuse.js 曖昧一致 → 未分類）。
 * LLM を本番投入する案: バックエンド `POST` で OpenAI/Claude に
 *   system: 支出カテゴリ名の一覧（GET /categories の expense のみ）を列挙し、1 行だけ返す
 *   user: 明細の「内容」
 * レスポンスの名前を上記一覧で検証。クライアントのこの関数の前段または置換で呼び出す。
 */
import Fuse from "fuse.js";
import { lookupLearnedCategory } from "./importCategoryLearner";

export type CategoryPredictSource = "learner" | "keyword" | "substring" | "fuzzy" | "default" | "kept";

export type CategoryPredictResult = {
  name: string;
  source: CategoryPredictSource;
  showAiBadge: boolean;
  showLearnedBadge: boolean;
};

const DEFAULT_UNCAT = "未分類";

/** 文字列の一部でマスター上の完全名を解決 */
function resolveName(part: string, names: string[]): string | null {
  const p = part.trim();
  if (!p) return null;
  const exact = names.find((n) => n === p);
  if (exact) return exact;
  return names.find((n) => n.includes(p) || p.includes(n)) ?? null;
}

type KeywordRule = { re: RegExp; pick: (names: string[]) => string | null };

/**
 * キーワード（加盟店・摘要） → カテゴリ名の片方にマッチする目印（image 想定 + 汎用）
 * 解決は必ず `names` 上の実在名に寄せる
 */
function buildKeywordRules(): KeywordRule[] {
  return [
    {
      re: /amazon|アマゾン|ＡＭＡＺＯＮ|\.co\.jp|コ\.jp|楽天市場|ヨドバシ|ビックカメラ|ニンテンドー|マイニンテンドー|ストア/i,
      pick: (names) => resolveName("食費", names) ?? names.find((n) => /食費|日用品|雑貨/.test(n)) ?? null,
    },
    { re: /固定費|家賃|地代|管理費|共益費|地代|ローン(?!車)/i, pick: (names) => names.find((n) => n.includes("固定")) ?? null },
    { re: /電気|ＴＥＰＣＯ|テプコ|関電|中部電|九州電|新電力|kwh|kWh/i, pick: (names) => names.find((n) => n.includes("電気")) ?? null },
    { re: /水道|印紙|上下水道|上水|下水|水道光熱|シジョウゲスイ|上水道/i, pick: (names) => names.find((n) => n.includes("水道")) ?? null },
    { re: /ガソリン|給油|ＥＮＥＯＳ|ＳＳ|高速|ＥＴＣ|スタンド|駐車|コインパ|洗車/i, pick: (names) => names.find((n) => n.includes("車")) ?? null },
    { re: /病院|クリニック|歯科|診療|薬局|ドラッグ|処方|医療|レセプト|薬剤/i, pick: (names) => names.find((n) => /医療|病院|健康/.test(n)) ?? null },
    { re: /スターバ|スタバ|外食|飲食|焼肉|居酒屋|松屋|すき家|マクド|ロッテリア|飲食店|レストラン|カフェ/i, pick: (names) => names.find((n) => n.includes("外食")) ?? null },
    { re: /スーパー|イオン|西友|セイコ|マルエツ|業務|食材|生鮮|惣菜/i, pick: (names) => names.find((n) => /食費|食品|日配/.test(n)) ?? null },
    { re: /ファミリーマート|セブン|ローソン|ミニスト|コンビニ|ＣＶＳ|ｃｖｓ/i, pick: (names) => names.find((n) => /食費|コンビニ|日用/.test(n)) ?? null },
    { re: /美容院|理容|ＢＢ|コスメ|ＯＩＨ|ＯＰＩ|メイク|ネイル|美容/i, pick: (names) => names.find((n) => n.includes("美容")) ?? null },
    { re: /ユニクロ|ＧＵ|Ｈ[＆&]Ｍ|ＺＡＲＡ|服|衣料|洋服|靴下/i, pick: (names) => names.find((n) => n.includes("衣")) ?? null },
    { re: /学研|学童|習い事|習字|英会話|通信教育|子供|キッズ|幼児/i, pick: (names) => names.find((n) => n.includes("子供")) ?? null },
    { re: /家賃|火災|地震保険|管理組合|修繕|リフォーム|ＤＩＹ|建具|不動産(?!税)/i, pick: (names) => names.find((n) => n.includes("住宅")) ?? null },
  ];
}

let keywordRules: KeywordRule[] | null = null;
function getKeywordRules(): KeywordRule[] {
  if (!keywordRules) keywordRules = buildKeywordRules();
  return keywordRules;
}

function findLongestNameInText(text: string, names: string[], uncat: string): string | null {
  const t = text.normalize("NFKC");
  const sorted = [...names].filter((n) => n && n !== uncat).sort((a, b) => b.length - a.length);
  for (const n of sorted) {
    if (n.length < 2) continue;
    if (t.includes(n)) return n;
  }
  return null;
}

function wordsFromContent(s: string): string[] {
  return s
    .normalize("NFKC")
    .replace(/^(paypay支払い|d払い|メルペイ払い|楽天ペイ払い|au\s*pay払い|クレジット払い|口座引落)\s*[:：]\s*/i, "")
    .split(/[\s,、。．\n\r/|：:]+/u)
    .map((w) => w.replace(/[（）()【】\[\]「」]/g, "").trim())
    .filter((w) => w.length >= 2);
}

function fuzzyBestCategory(content: string, names: string[], uncat: string): string | null {
  if (names.length === 0) return null;
  const pool = names.filter((n) => n !== uncat);
  if (pool.length === 0) return null;
  const items = pool.map((n) => ({ n }));
  const fuse = new Fuse(items, { keys: ["n"], includeScore: true, threshold: 0.45, ignoreLocation: true, minMatchCharLength: 2 });
  const words = wordsFromContent(content);
  let best: { n: string; score: number } | null = null;
  for (const w of words) {
    if (w.length < 2) continue;
    const r = fuse.search(w);
    const top = r[0];
    if (top && top.item) {
      const s = top.score ?? 1;
      if (best == null || s < best.score) {
        best = { n: top.item.n, score: s };
      }
    }
  }
  if (best && best.score < 0.42) return best.n;
  return null;
}

function pickDefaultUncategorized(expenseNames: string[]): string {
  return expenseNames.find((n) => n === DEFAULT_UNCAT) ?? expenseNames[0] ?? DEFAULT_UNCAT;
}

export function predictImportCategory(input: {
  content: string;
  expenseNames: string[];
}): CategoryPredictResult {
  const names = input.expenseNames.map((n) => String(n).trim()).filter(Boolean);
  const uncat = pickDefaultUncategorized(names);
  const text = String(input.content ?? "")
    .trim()
    .replace(/^(paypay支払い|d払い|メルペイ払い|楽天ペイ払い|au\s*pay払い|クレジット払い|口座引落)\s*[:：]\s*/i, "");
  if (!text) {
    return { name: uncat, source: "default", showAiBadge: false, showLearnedBadge: false };
  }

  const learned = lookupLearnedCategory(text);
  if (learned && names.includes(learned)) {
    return { name: learned, source: "learner", showAiBadge: false, showLearnedBadge: true };
  }

  for (const rule of getKeywordRules()) {
    if (rule.re.test(text)) {
      const hit = rule.pick(names);
      if (hit) {
        return { name: hit, source: "keyword", showAiBadge: true, showLearnedBadge: false };
      }
    }
  }

  const sub = findLongestNameInText(text, names, uncat);
  if (sub) {
    return { name: sub, source: "substring", showAiBadge: true, showLearnedBadge: false };
  }

  const fuseHit = fuzzyBestCategory(text, names, uncat);
  if (fuseHit) {
    return { name: fuseHit, source: "fuzzy", showAiBadge: true, showLearnedBadge: false };
  }

  return { name: uncat, source: "default", showAiBadge: false, showLearnedBadge: false };
}

/**
 * CSV/解析に具体的なカテゴリ名が入っている場合のみ優先（「未分類」は予測へ回す）
 */
export function mergeWithExistingGuess(
  result: CategoryPredictResult,
  categoryGuess: string,
  names: string[],
): CategoryPredictResult {
  const g = String(categoryGuess ?? "").trim();
  if (!g || g === DEFAULT_UNCAT) return result;
  if (names.includes(g)) {
    return { name: g, source: "kept", showAiBadge: false, showLearnedBadge: false };
  }
  return result;
}
