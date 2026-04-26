/**
 * レシート店名（OCR）の正規化・永続化キー（SHA-256）— 外部 API には非依存
 */
import crypto from "node:crypto";

/**
 * キャッシュ・キー用の正規化
 * @param {string} s
 * @returns {string}
 */
export function normalizeOcrVendorForKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "");
}

/**
 * @param {string} vendor
 * @returns {string} hex
 */
export function ocrVendorFingerprintHex(vendor) {
  return crypto
    .createHash("sha256")
    .update(normalizeOcrVendorForKey(vendor), "utf8")
    .digest("hex");
}
