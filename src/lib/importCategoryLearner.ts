/**
 * 取込プレビュー: 手動で選んだ（内容 → カテゴリ名）のペアを保持し、次回の即時照合に使う。
 * 永続: localStorage（DB 版は /import の学習 API 追加で差し替え可能）
 */

const STORAGE_KEY = "kakeibo.importCategoryLearner.v1";
const MAX_RULES = 200;

type Store = { rules: { k: string; c: string; t: number }[] };

function loadStore(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { rules: [] };
    const p = JSON.parse(raw) as Store;
    if (!p || !Array.isArray(p.rules)) return { rules: [] };
    return { rules: p.rules.filter((r) => r && typeof r.k === "string" && typeof r.c === "string") };
  } catch {
    return { rules: [] };
  }
}

function saveStore(s: Store) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* プライベートモード等 */
  }
}

export function normalizeImportContentKey(memo: string): string {
  return String(memo ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    .trim();
}

/**
 * 直近登録分から逆順に最初の一致（同一キーは上書き更新）
 */
export function lookupLearnedCategory(memo: string): string | null {
  const k = normalizeImportContentKey(memo);
  if (!k) return null;
  const { rules } = loadStore();
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    if (rules[i].k === k) return rules[i].c;
  }
  return null;
}

/**
 * 完全一致が無い場合の救済: 学習済みキーとの部分一致（長いキーを優先）。
 */
export function lookupLearnedCategoryByPartial(memo: string): string | null {
  const k = normalizeImportContentKey(memo);
  if (!k || k.length < 3) return null;
  const { rules } = loadStore();
  let best: { c: string; len: number } | null = null;
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    const rk = String(rule?.k ?? "");
    if (!rk || rk.length < 3) continue;
    if (!(k.includes(rk) || rk.includes(k))) continue;
    if (!best || rk.length > best.len) {
      best = { c: rule.c, len: rk.length };
    }
  }
  return best?.c ?? null;
}

export function recordImportCategoryRule(memo: string, categoryName: string) {
  const k = normalizeImportContentKey(memo);
  if (!k || !categoryName.trim()) return;
  const c = categoryName.trim();
  const store = loadStore();
  const next = store.rules.filter((r) => r.k !== k);
  next.push({ k, c, t: Date.now() });
  while (next.length > MAX_RULES) next.shift();
  saveStore({ rules: next });
}
