/**
 * アプリ本編のメイン導線（ラベル・遷移先の単一定義元）
 */
export type MainNavItem = {
  id: string;
  label: string;
  kind?: "link" | "action";
  to?: string;
  actionId?: "features" | "howto";
  /**
   * NavLink `end` — 例: 家計簿 `/` のみ一致
   */
  end?: boolean;
  /** 管理 — 表示は getVisibleMainNavItems で権限フィルタ */
  adminOnly?: boolean;
};

/**
 * メンテナンス用の単一定数。`GlassMainNav` は `getVisibleMainNavItems` 経由で使用。
 */
export const NAV_ITEMS: MainNavItem[] = [
  { id: "dashboard", to: "/dashboard", label: "ダッシュボード", kind: "link" },
  { id: "kakeibo", to: "/", label: "家計簿", end: true, kind: "link" },
  { id: "import", to: "/import", label: "おまかせ取込", kind: "link" },
  { id: "settings", to: "/settings", label: "設定", kind: "link" },
  { id: "features", label: "機能紹介", kind: "action", actionId: "features" },
  { id: "howto", label: "使い方", kind: "action", actionId: "howto" },
  { id: "admin", to: "/admin", label: "管理", adminOnly: true, kind: "link" },
];

/** @deprecated 以前の名。NAV_ITEMS と同一。 */
export const BASE_MAIN_NAV_ITEMS = NAV_ITEMS;

export function getVisibleMainNavItems(params: { isAdmin: boolean }): MainNavItem[] {
  return NAV_ITEMS.filter((item) => (item.adminOnly ? params.isAdmin : true));
}
