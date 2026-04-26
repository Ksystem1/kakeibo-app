/**
 * Google Places API (New) text search — 曖昧な店名の名寄せ用
 * 環境変数 GOOGLE_PLACES_API_KEY が未設定のときは no-op
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

/**
 * @param {string} textQuery
 * @returns {Promise<null | { placeId: string; displayName: string; formattedAddress: string }>}
 */
export async function placesTextSearchOne(textQuery) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key || !String(textQuery).trim()) return null;
  const q = String(textQuery).trim().slice(0, 400);
  const url = "https://places.googleapis.com/v1/places:searchText";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
      },
      body: JSON.stringify({ textQuery: q, languageCode: "ja" }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const p = j?.places?.[0];
    if (!p) return null;
    const dname = p.displayName;
    const displayName =
      typeof dname === "string"
        ? dname
        : dname && typeof dname === "object" && "text" in dname
          ? String(/** @type {{ text: string }} */ (dname).text)
          : String(dname ?? "").trim();
    return {
      placeId: p.id != null ? String(p.id) : "",
      displayName: displayName.slice(0, 500),
      formattedAddress: p.formattedAddress != null ? String(p.formattedAddress).slice(0, 1000) : "",
    };
  } catch {
    return null;
  }
}
