/**
 * ナビ用アイコンのスキン（着せ替え）設定。
 * 新スキン追加: public/skins/Tmp02/ に画像を置き、CURRENT_SKIN を差し替える。
 * 本番は base が /kakeibo/ のため、URL は必ず import.meta.env.BASE_URL から組み立てる。
 */
export const CURRENT_SKIN = "Tmp01" as const;

const skinBase = `${import.meta.env.BASE_URL}skins/${CURRENT_SKIN}`;

/** スキン配下のナビアイコン（拡張時はキーとファイル名を追加） */
export const ICON_PATHS = {
  dashboard: `${skinBase}/dashboard.png`,
  kakeibo: `${skinBase}/kakeibo.png`,
} as const;
