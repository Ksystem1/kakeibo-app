/**
 * ナビ用アイコンのスキン（着せ替え）。
 * 各スキンは `public/skins/<id>/` に `1_1.png` … `1_6.png`（ASCII 名）を配置。
 *
 * 購入状態は現状 localStorage（`kakeibo_owned_nav_skins`）。将来 API のユーザー設定と
 * SettingsContext の `mergeOwnedNavSkinsFromServer(ids)` でマージする想定。
 * 例: `GET /auth/me` の応答に `owned_nav_skin_ids: string[]` を載せたら、
 * ログイン同期後にその配列を渡す。
 */

export const DEFAULT_NAV_SKIN_ID = "Tmp01";

export type NavSkinDefinition = {
  id: string;
  label: string;
  /** true のとき未購入でも選択可能（既定・無料スキン） */
  free: boolean;
  description?: string;
};

export const NAV_SKIN_CATALOG: readonly NavSkinDefinition[] = [
  {
    id: "Tmp01",
    label: "スタンダード",
    free: true,
    description: "既定のナビアイコン",
  },
  {
    id: "Tmp02",
    label: "プレミアム",
    free: false,
    description: "有料販売予定（未購入のときは選択不可）",
  },
] as const;

export type NavIconPaths = {
  dashboard: string;
  kakeibo: string;
  csvPc: string;
  receipt: string;
  settings: string;
  admin: string;
};

export function isKnownNavSkinId(id: string): boolean {
  return NAV_SKIN_CATALOG.some((s) => s.id === id);
}

export function getNavSkinDefinition(id: string): NavSkinDefinition | undefined {
  return NAV_SKIN_CATALOG.find((s) => s.id === id);
}

export function isNavSkinUnlocked(skinId: string, ownedSkinIds: readonly string[]): boolean {
  const def = getNavSkinDefinition(skinId);
  if (!def) return false;
  if (def.free) return true;
  return ownedSkinIds.includes(skinId);
}

/** メインナビ 6 種（1 ダッシュボード 2 家計簿 3 CSV 4 レシート 5 設定 6 管理） */
export function buildNavIconPaths(skinId: string): NavIconPaths {
  const skinBase = `${import.meta.env.BASE_URL}skins/${skinId}`;
  return {
    dashboard: `${skinBase}/1_1.png`,
    kakeibo: `${skinBase}/1_2.png`,
    csvPc: `${skinBase}/1_3.png`,
    receipt: `${skinBase}/1_4.png`,
    settings: `${skinBase}/1_5.png`,
    admin: `${skinBase}/1_6.png`,
  };
}

export function resolveEffectiveNavSkinId(
  selectedId: string,
  ownedSkinIds: readonly string[],
): string {
  if (!isKnownNavSkinId(selectedId)) return DEFAULT_NAV_SKIN_ID;
  if (isNavSkinUnlocked(selectedId, ownedSkinIds)) return selectedId;
  return DEFAULT_NAV_SKIN_ID;
}
