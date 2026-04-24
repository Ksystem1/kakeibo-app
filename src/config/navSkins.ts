/**
 * ナビ用アイコンのスキン（着せ替え）。
 * 各スキンは `public/skins/<id>/` に `1_1.png` … `1_6.png`（ASCII 名）を配置。
 *
 * 画面上部の切替は「スタンダード」「プレミアム」の2ボタンのみ。
 * プレミアム会員は Tmp02 / Tmp03 / Tmp04 … を別行で選択可能（フォルダが存在しアセットが揃う場合のみ表示）。
 */

export const DEFAULT_NAV_SKIN_ID = "Tmp01";

/** プレミアム枠の代表ID（上位「プレミアム」ボタンと紐づく） */
export const PREMIUM_NAV_SKIN_ID = "Tmp02";

/** プレミアムで選択可能なフォルダ（新規追加時はここに足す） */
export const PREMIUM_VARIANT_SKIN_IDS = ["Tmp02", "Tmp03", "Tmp04", "Tmp05", "Tmp06"] as const;

/** @deprecated PREMIUM_VARIANT_SKIN_IDS を使用 */
export const PREMIUM_NAV_SKIN_IDS = PREMIUM_VARIANT_SKIN_IDS;

export type NavSkinDefinition = {
  id: string;
  label: string;
  /** true のとき未購入でも選択可能（既定・無料スキン） */
  free: boolean;
  description?: string;
};

/**
 * 設定画面上部の2ボタン用（スタンダード / プレミアムのみ）
 */
export const NAV_SKIN_TIER_CATALOG: readonly NavSkinDefinition[] = [
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
    description: "プレミアム用スキン（Tmp02〜から選択）",
  },
] as const;

/** 後方互換: 旧名 */
export const NAV_SKIN_CATALOG = NAV_SKIN_TIER_CATALOG;

export function getPremiumVariantLabel(id: string): string {
  switch (id) {
    case "Tmp02":
      return "飲食店";
    case "Tmp03":
      return "くだもの";
    case "Tmp04":
      return "古代風";
    case "Tmp05":
      return "ギャル風";
    case "Tmp06":
      return "クラシック風";
    default:
      return id;
  }
}

export function isPremiumVariantSkinId(id: string): boolean {
  return (PREMIUM_VARIANT_SKIN_IDS as readonly string[]).includes(id);
}

export function isKnownNavSkinId(id: string): boolean {
  if (id === DEFAULT_NAV_SKIN_ID) return true;
  return isPremiumVariantSkinId(id);
}

export function firstAvailablePremiumVariantId(availableIds: readonly string[]): string | null {
  for (const id of PREMIUM_VARIANT_SKIN_IDS) {
    if (availableIds.includes(id)) return id;
  }
  return null;
}

export function getNavSkinDefinition(id: string): NavSkinDefinition | undefined {
  const tier = NAV_SKIN_TIER_CATALOG.find((s) => s.id === id);
  if (tier) return tier;
  if (isPremiumVariantSkinId(id) && id !== PREMIUM_NAV_SKIN_ID) {
    return {
      id,
      label: getPremiumVariantLabel(id),
      free: false,
      description: `${id}（プレミアム）`,
    };
  }
  return undefined;
}

export function isNavSkinUnlocked(skinId: string, ownedSkinIds: readonly string[]): boolean {
  const def = getNavSkinDefinition(skinId);
  if (!def) return false;
  if (def.free) return true;
  return ownedSkinIds.includes(skinId);
}

export type NavIconPaths = {
  dashboard: string;
  kakeibo: string;
  csvPc: string;
  receipt: string;
  settings: string;
  admin: string;
};

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
