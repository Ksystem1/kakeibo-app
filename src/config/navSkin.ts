/**
 * ナビ用アイコンのスキン（着せ替え）設定。
 * Tmp01 は `1_1.png` … `1_6.png`（ASCII 名）を配置。
 * 新スキン: public/skins/Tmp02/ を用意し CURRENT_SKIN を差し替え。
 */
export const CURRENT_SKIN = "Tmp01" as const;

const skinBase = `${import.meta.env.BASE_URL}skins/${CURRENT_SKIN}`;

/** メインナビ 6 種（1 ダッシュボード 2 家計簿 3 CSV 4 レシート 5 設定 6 管理） */
export const ICON_PATHS = {
  dashboard: `${skinBase}/1_1.png`,
  kakeibo: `${skinBase}/1_2.png`,
  csvPc: `${skinBase}/1_3.png`,
  receipt: `${skinBase}/1_4.png`,
  settings: `${skinBase}/1_5.png`,
  admin: `${skinBase}/1_6.png`,
} as const;
