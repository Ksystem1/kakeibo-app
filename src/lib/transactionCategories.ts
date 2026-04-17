/** 取引では使わず設定画面の固定費のみで管理するカテゴリ名（正規化後の完全一致） */
export const RESERVED_LEDGER_FIXED_COST_CATEGORY_NAME = "固定費";

/** カテゴリ名の表記ゆれ（NFKC・ゼロ幅・前後空白）を寄せてから比較する */
export function normalizeLedgerCategoryNameForCompare(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff\u2060]/g, "")
    .trim();
}

export function isReservedLedgerFixedCostCategoryName(name: string | null | undefined): boolean {
  return normalizeLedgerCategoryNameForCompare(name) === RESERVED_LEDGER_FIXED_COST_CATEGORY_NAME;
}

export function filterCategoriesForTransactionSelect<T extends { name: string }>(items: readonly T[]): T[] {
  return items.filter((c) => !isReservedLedgerFixedCostCategoryName(c.name));
}
