/**
 * 統合取込口: 拡張子優先（iOS で text/plain になりやすい）
 */
const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".svg",
  ".tif",
  ".tiff",
]);

export function isCsvFileName(name: string): boolean {
  return (name || "").trim().toLowerCase().endsWith(".csv");
}

function extnameLower(name: string): string {
  const n = (name || "").trim().toLowerCase();
  const i = n.lastIndexOf(".");
  if (i <= 0) return "";
  return n.slice(i);
}

/**
 * レシート用画像とみなす（拡張子 or MIME、どちらかで可）
 */
export function isReceiptImageFile(file: File): boolean {
  const t = (file.type || "").toLowerCase();
  if (t.startsWith("image/")) return true;
  const ext = extnameLower(file.name);
  return ext !== "" && IMAGE_EXTS.has(ext);
}

export function isTxtFileName(name: string): boolean {
  return (name || "").trim().toLowerCase().endsWith(".txt");
}

/** 取込用 accept（1つの input 用） */
export const UNIFIED_IMPORT_ACCEPT = ".csv, text/csv, text/plain, image/*, .txt";
