/**
 * user_store_places: 高速キャッシュ取得・店名名寄せ（Amazon Bedrock）の永続化・学習カテゴリ
 */
import { bedrockResolveSuggestedVendor } from "./ai-advisor-service.mjs";
import { ocrVendorFingerprintHex } from "./vendor-fingerprint.mjs";

/**
 * @param {string} [code]
 * @returns {string}
 */
function userHintForBedrockFailure(code) {
  const c = String(code || "");
  if (c === "AccessDeniedException" || c === "AccessDenied" || c === "UnauthorizedOperation") {
    return "解析中ですが、店名推論をスキップしました。手入力のままご利用ください。（AI 権限・モデル利用設定のご確認が必要な場合があります）。";
  }
  if (c === "ThrottlingException" || c === "TooManyRequestsException" || c === "ServiceQuotaExceededException") {
    return "解析中ですが、店名推論を一時的にスキップしました。少し時間を空けて再度お試しください。";
  }
  if (c === "ResourceNotFoundException" || c === "ValidationException") {
    return "解析中ですが、店名推論をスキップしました（利用モデル設定をご確認ください）。";
  }
  return "解析中ですが、店名推論をスキップしました。手入力のままご利用ください。";
}

/** `app-core` の `catWhere` と同一（家族/本人の支出カテゴリ名の取得用） */
const CAT_WHERE_FOR_USER = `(c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (c.family_id IS NULL AND c.user_id = ?))`;

/**
 * 家計簿の支出カテゴリ名（UI のカテゴリ一覧 image_8c1cba.png と同じ DB 集合）
 * @param {import("mysql2/promise").Pool} pool
 * @param {number|string} userId
 * @returns {Promise<string[]>}
 */
export async function loadUserExpenseCategoryNameList(pool, userId) {
  const [rows] = await pool.query(
    `SELECT c.name
     FROM categories c
     WHERE ${CAT_WHERE_FOR_USER} AND c.is_archived = 0 AND c.kind = 'expense'
     ORDER BY c.sort_order, c.id`,
    [userId, userId],
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (r && r.name != null ? String(r.name).trim() : ""))
    .filter((n) => n.length > 0);
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {number|string} userId
 * @param {string} vendorName
 * @returns {Promise<null | { ocrVendorKey: string, placeId: string, suggestedStoreName: string, locationHint: string, preferredCategoryId: number | null }>}
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
      suggestedStoreName: r.display_name != null ? String(r.display_name) : "",
      locationHint: r.formatted_address != null ? String(r.formatted_address) : "",
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
    suggestedStoreName: r.display_name != null ? String(r.display_name) : "",
    locationHint: r.formatted_address != null ? String(r.formatted_address) : "",
    preferredCategoryId: null,
  };
}

/**
 * Bedrock 名寄せ → INSERT（解析本体とは別リクエスト用。外部地図 API は使わない。）
 * @returns {Promise<
 *   | null
 *   | { ok: true, fromCache: true, saved: true, placeId: string, suggestedStoreName: string, locationHint: string, suggestedExpenseCategoryName: null, ocrVendorKey: string }
 *   | { ok: true, fromCache: false, saved: true, placeId: string, suggestedStoreName: string, locationHint: string, suggestedExpenseCategoryName: string | null, ocrVendorKey: string, inferenceConfidence: number, inferenceLowConfidence: boolean }
 *   | { ok: true, fromCache: false, saved: false, placeId: string, suggestedStoreName: string, locationHint: string, suggestedExpenseCategoryName: string | null, ocrVendorKey: string, inferenceConfidence: number, inferenceLowConfidence: boolean }
 *   | { ok: false, reason: "bedrock", ocrVendorKey: string, bedrockCode?: string, userHint: string }
 * >}
 */
export async function resolveAndPersistUserStorePlace(pool, userId, vendorName) {
  const v = String(vendorName ?? "").trim();
  if (v.length < 2) return null;
  const ocrVendorKey = ocrVendorFingerprintHex(v);
  const placeId = "";
  const cached = await getUserStorePlaceCached(pool, userId, v);
  if (cached) {
    return {
      ok: true,
      fromCache: true,
      saved: true,
      ocrVendorKey: cached.ocrVendorKey,
      placeId: cached.placeId,
      suggestedStoreName: cached.suggestedStoreName,
      locationHint: cached.locationHint,
      suggestedExpenseCategoryName: null,
      inferenceConfidence: 1,
      inferenceLowConfidence: false,
    };
  }
  const expenseCategoryNames = await loadUserExpenseCategoryNameList(pool, userId);
  const br = await bedrockResolveSuggestedVendor(v, { expenseCategoryNames });
  if (!br.ok) {
    return {
      ok: false,
      reason: "bedrock",
      ocrVendorKey,
      bedrockCode: br.code,
      userHint: userHintForBedrockFailure(br.code),
    };
  }
  const rowHint = br.locationHint || null;
  const inferenceConfidence = Number.isFinite(Number(br.inferenceConfidence))
    ? Math.max(0, Math.min(1, Number(br.inferenceConfidence)))
    : 0.7;
  const inferenceLowConfidence = Boolean(br.inferenceLowConfidence);
  const base = {
    ok: true,
    fromCache: false,
    ocrVendorKey,
    placeId,
    suggestedStoreName: br.suggestedStoreName,
    locationHint: br.locationHint,
    suggestedExpenseCategoryName: br.suggestedExpenseCategoryName,
    inferenceConfidence,
    inferenceLowConfidence,
  };
  try {
    await pool.query(
      `INSERT INTO user_store_places
        (user_id, ocr_vendor_key, place_id, display_name, formatted_address)
       VALUES (?, ?, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE
         place_id = NULL,
         display_name = VALUES(display_name),
         formatted_address = VALUES(formatted_address),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, ocrVendorKey, br.suggestedStoreName, rowHint],
    );
  } catch (e) {
    const c = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    if (c === "ER_NO_SUCH_TABLE") {
      return { ...base, saved: false };
    }
    return {
      ok: false,
      reason: "bedrock",
      ocrVendorKey,
      userHint: userHintForBedrockFailure("DBError"),
    };
  }
  return { ...base, saved: true };
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
 * 行がなければ最小行を INSERT し、名寄せ前でも「店名キー×カテゴリ」を学習できる。
 * v41 未適用時は ER_BAD_FIELD_ERROR で失わずに false を返す（呼び出し側で無視可）。
 * @param {string | null} vendorNameForResolve 行がなく、名寄せ（Bedrock）も走らせる場合に渡す
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
      const r0 = await resolveAndPersistUserStorePlace(pool, userId, v);
      if (r0 && "ok" in r0 && r0.ok) {
        n = await tryUpdate();
        if (n > 0) return { ok: true, affected: n };
      }
    }
    const ins = await tryInsertUpsert();
    if (ins < 0) {
      if (v.length >= 2) {
        const resolved = await resolveAndPersistUserStorePlace(pool, userId, v);
        if (resolved && "ok" in resolved && resolved.ok && resolved.saved) {
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
