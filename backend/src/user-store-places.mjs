/**
 * user_store_places: 高速キャッシュ取得・Places 名寄せ永続化・学習カテゴリ
 */
import { ocrVendorFingerprintHex, placesTextSearchOne } from "./google-places.mjs";

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number|string} userId
 * @param {string} vendorName
 * @returns {Promise<null | { ocrVendorKey: string, placeId: string, displayName: string, formattedAddress: string, preferredCategoryId: number | null }>}
 */
export async function getUserStorePlaceCached(pool, userId, vendorName) {
  const v = String(vendorName ?? "").trim();
  if (v.length < 2) return null;
  const ocrVendorKey = ocrVendorFingerprintHex(v);
  try {
    const [rows] = await pool.query(
      `SELECT place_id, display_name, formatted_address, preferred_category_id
       FROM user_store_places
       WHERE user_id = ? AND ocr_vendor_key = ?
       LIMIT 1`,
      [userId, ocrVendorKey],
    );
    if (!Array.isArray(rows) || !rows[0]) return null;
    const r = rows[0];
    return {
      ocrVendorKey,
      placeId: r.place_id != null ? String(r.place_id) : "",
      displayName: r.display_name != null ? String(r.display_name) : "",
      formattedAddress: r.formatted_address != null ? String(r.formatted_address) : "",
      preferredCategoryId:
        r.preferred_category_id != null && r.preferred_category_id !== ""
          ? Number(r.preferred_category_id)
          : null,
    };
  } catch (e) {
    const c = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    if (c === "ER_NO_SUCH_TABLE" || c === "ER_BAD_FIELD_ERROR") {
      if (c === "ER_BAD_FIELD_ERROR") {
        return getUserStorePlaceCachedLegacyNoPrefColumn(pool, userId, ocrVendorKey);
      }
      return null;
    }
    throw e;
  }
}

async function getUserStorePlaceCachedLegacyNoPrefColumn(pool, userId, ocrVendorKey) {
  const [rows] = await pool.query(
    `SELECT place_id, display_name, formatted_address
     FROM user_store_places
     WHERE user_id = ? AND ocr_vendor_key = ?
     LIMIT 1`,
    [userId, ocrVendorKey],
  );
  if (!Array.isArray(rows) || !rows[0]) return null;
  const r = rows[0];
  return {
    ocrVendorKey,
    placeId: r.place_id != null ? String(r.place_id) : "",
    displayName: r.display_name != null ? String(r.display_name) : "",
    formattedAddress: r.formatted_address != null ? String(r.formatted_address) : "",
    preferredCategoryId: null,
  };
}

/**
 * Google Places 検索 → INSERT（解析本体とは別リクエスト用）
 * @returns {Promise<null | { fromCache: boolean, saved: boolean, placeId: string, displayName: string, formattedAddress: string, ocrVendorKey: string }>}
 */
export async function resolveAndPersistUserStorePlace(pool, userId, vendorName) {
  const v = String(vendorName ?? "").trim();
  if (v.length < 2) return null;
  const ocrVendorKey = ocrVendorFingerprintHex(v);
  const cached = await getUserStorePlaceCached(pool, userId, v);
  if (cached) {
    return {
      fromCache: true,
      saved: true,
      ocrVendorKey: cached.ocrVendorKey,
      placeId: cached.placeId,
      displayName: cached.displayName,
      formattedAddress: cached.formattedAddress,
    };
  }
  const found = await placesTextSearchOne(`${v} 日本`);
  if (!found) return null;
  try {
    await pool.query(
      `INSERT INTO user_store_places
        (user_id, ocr_vendor_key, place_id, display_name, formatted_address)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         place_id = VALUES(place_id),
         display_name = VALUES(display_name),
         formatted_address = VALUES(formatted_address),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, ocrVendorKey, found.placeId, found.displayName, found.formattedAddress],
    );
  } catch (e) {
    const c = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    if (c === "ER_NO_SUCH_TABLE") {
      return {
        fromCache: false,
        saved: false,
        ocrVendorKey,
        placeId: found.placeId,
        displayName: found.displayName,
        formattedAddress: found.formattedAddress,
      };
    }
    return null;
  }
  return {
    fromCache: false,
    saved: true,
    ocrVendorKey,
    placeId: found.placeId,
    displayName: found.displayName,
    formattedAddress: found.formattedAddress,
  };
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number|string} userId
 * @param {string} ocrVendorKey
 * @param {number | null} categoryId
 */
export async function setUserStorePlacePreferredCategory(
  pool,
  userId,
  ocrVendorKey,
  categoryId,
) {
  const r = await upsertPreferredCategoryForOcrKey(pool, userId, ocrVendorKey, categoryId, null);
  if (!r.ok) return r;
  return { ok: true, affected: r.affected };
}

/**
 * 行がなければ最小行を INSERT し、Places 解決前でも「店名キー×カテゴリ」を学習できる。
 * v41 未適用時は ER_BAD_FIELD_ERROR で失わずに false を返す（呼び出し側で無視可）。
 * @param {string | null} vendorNameForResolve 行がなく、Google で名寄せもしたい場合に渡す
 */
export async function upsertPreferredCategoryForOcrKey(
  pool,
  userId,
  ocrVendorKey,
  categoryId,
  vendorNameForResolve,
) {
  const k = String(ocrVendorKey ?? "").trim();
  if (!/^[a-f0-9]{64}$/i.test(k)) return { ok: false, reason: "invalid_key" };
  const cat =
    categoryId == null || categoryId === "" ? null : Number.isFinite(Number(categoryId))
      ? Number(categoryId)
      : null;
  const tryUpdate = async () => {
    const [r] = await pool.query(
      `UPDATE user_store_places
       SET preferred_category_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND ocr_vendor_key = ?`,
      [cat, userId, k],
    );
    return r?.affectedRows ?? 0;
  };
  const tryInsertUpsert = async () => {
    try {
      await pool.query(
        `INSERT INTO user_store_places
          (user_id, ocr_vendor_key, place_id, display_name, formatted_address, preferred_category_id)
         VALUES (?, ?, NULL, NULL, NULL, ?)
         ON DUPLICATE KEY UPDATE
           preferred_category_id = VALUES(preferred_category_id),
           updated_at = CURRENT_TIMESTAMP`,
        [userId, k, cat],
      );
      return 1;
    } catch (e) {
      const c = e && typeof e === "object" && "code" in e ? String(e.code) : "";
      if (c === "ER_NO_SUCH_TABLE" || c === "ER_BAD_FIELD_ERROR") {
        return -1;
      }
      throw e;
    }
  };
  try {
    let n = await tryUpdate();
    if (n > 0) return { ok: true, affected: n };
    const v = String(vendorNameForResolve ?? "").trim();
    if (v.length >= 2) {
      await resolveAndPersistUserStorePlace(pool, userId, v);
      n = await tryUpdate();
      if (n > 0) return { ok: true, affected: n };
    }
    const ins = await tryInsertUpsert();
    if (ins < 0) {
      if (v.length >= 2) {
        const resolved = await resolveAndPersistUserStorePlace(pool, userId, v);
        if (resolved?.saved) {
          n = await tryUpdate();
          if (n > 0) return { ok: true, affected: n };
        }
      }
      return { ok: false, reason: "schema_or_no_row" };
    }
    return { ok: true, affected: 1 };
  } catch (e) {
    const c = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    if (c === "ER_NO_SUCH_TABLE" || c === "ER_BAD_FIELD_ERROR") {
      return { ok: false, reason: c };
    }
    throw e;
  }
}
