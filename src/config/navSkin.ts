/**
 * ナビ用アイコンのスキン（着せ替え）設定。
 * Tmp01 のファイル名は「1_①.png」形式（Unicode 丸数字）。URL では encodeURIComponent でエンコードする。
 * 新スキン: public/skins/Tmp02/ を用意し CURRENT_SKIN を差し替え。
 */
export const CURRENT_SKIN = "Tmp01" as const;

const skinBase = `${import.meta.env.BASE_URL}skins/${CURRENT_SKIN}`;

function skinIconEncoded(file: string): string {
  return `${skinBase}/${encodeURIComponent(file)}`;
}

/** メインナビ 6 種（①ダッシュボード ②家計簿 ③CSV ④レシート ⑤設定 ⑥管理） */
export const ICON_PATHS = {
  dashboard: skinIconEncoded("1_①.png"),
  kakeibo: skinIconEncoded("1_②.png"),
  csvPc: skinIconEncoded("1_③.png"),
  receipt: skinIconEncoded("1_④.png"),
  settings: skinIconEncoded("1_⑤.png"),
  admin: skinIconEncoded("1_⑥.png"),
} as const;
