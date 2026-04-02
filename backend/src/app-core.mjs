/**
 * Lambda / Express 共通ルータ
 */
import crypto from "node:crypto";
import { stripApiPathPrefix } from "./api-path.mjs";
import { tryAuthRoutes, getDefaultFamilyId } from "./auth-routes.mjs";
import { hashPassword, resolveUserId } from "./auth-logic.mjs";
import { buildCorsHeaders } from "./cors-config.mjs";
import { getPool, isRdsConfigured, pingDatabase } from "./db.mjs";
import { createLogger } from "./logger.mjs";
import {
  analyzeReceiptImageBytes,
  decodeImageBuffer,
} from "./textract-receipt.mjs";

const logger = createLogger("api");

function logError(event, e, extra = {}) {
  logger.error(event, e, extra);
}

function json(statusCode, body, reqHeaders, skipCors) {
  const cors = skipCors ? {} : buildCorsHeaders(reqHeaders);
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...cors,
    },
    body: JSON.stringify(body),
  };
}

function routeKey(method, path) {
  const p = path.replace(/\/$/, "") || "/";
  return `${method} ${p}`;
}

const RECEIPT_CATEGORY_KEYWORDS = {
  food: [
    "りんご",
    "バナナ",
    "野菜",
    "肉",
    "魚",
    "牛乳",
    "卵",
    "パン",
    "米",
    "弁当",
    "飲料",
    "ジュース",
    "スーパー",
    "コンビニ",
  ],
  daily: ["ティッシュ", "洗剤", "シャンプー", "歯ブラシ", "トイレットペーパー", "日用品"],
  transport: ["電車", "バス", "タクシー", "駐車", "ガソリン", "高速", "ic"],
  utility: ["電気", "ガス", "水道", "通信", "wifi", "インターネット", "携帯"],
  medical: ["薬", "病院", "診療", "処方", "クリニック"],
  leisure: ["映画", "カフェ", "外食", "レジャー", "趣味", "書籍"],
};

const RECEIPT_CATEGORY_ALIASES = {
  food: ["食費", "食品", "食料品", "飲食", "スーパー", "グロサリー", "grocery", "food"],
  daily: ["日用品", "雑貨", "生活用品", "ドラッグ", "ドラッグストア"],
  transport: ["交通", "交通費", "電車", "バス", "タクシー", "ガソリン", "駐車場"],
  utility: ["水道", "光熱費", "電気", "ガス", "通信", "ネット", "携帯"],
  medical: ["医療", "病院", "薬", "薬局", "ドラッグ"],
  leisure: ["娯楽", "交際", "外食", "趣味", "レジャー"],
};

function normalizeKeyword(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[　]/g, "");
}

function normalizeVendorName(s) {
  return normalizeKeyword(s)
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "");
}

function tagFromCategoryName(name) {
  const n = normalizeKeyword(name);
  for (const [tag, aliases] of Object.entries(RECEIPT_CATEGORY_ALIASES)) {
    if (aliases.some((a) => n.includes(normalizeKeyword(a)))) return tag;
  }
  return null;
}

async function suggestExpenseCategoryFromHistory(pool, userId, txWhere, vendor) {
  const memo = String(vendor ?? "").trim();
  if (!memo) return null;
  const normMemo = normalizeVendorName(memo);
  if (!normMemo) return null;

  const normalizedMemoExpr =
    "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(t.memo), ' ', ''), '　', ''), '株式会社', ''), '(株)', ''))";

  // まずは正規化完全一致で履歴学習カテゴリを選ぶ
  const [rows] = await pool.query(
    `SELECT t.category_id, c.name, COUNT(*) AS used_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND t.category_id IS NOT NULL
       AND c.kind = 'expense'
       AND c.is_archived = 0
       AND ${normalizedMemoExpr} = ?
     GROUP BY t.category_id, c.name
     ORDER BY used_count DESC, t.category_id ASC
     LIMIT 1`,
    [userId, userId, normMemo],
  );
  if (Array.isArray(rows) && rows.length > 0) {
    const top = rows[0];
    return {
      id: Number(top.category_id),
      name: String(top.name),
      source: "history",
    };
  }

  // 次に包含一致（「イオン」「イオンスタイル」など）で緩く推定
  const [fuzzyRows] = await pool.query(
    `SELECT t.category_id, c.name, COUNT(*) AS used_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND t.category_id IS NOT NULL
       AND c.kind = 'expense'
       AND c.is_archived = 0
       AND (
         INSTR(${normalizedMemoExpr}, ?) > 0
         OR INSTR(?, ${normalizedMemoExpr}) > 0
       )
     GROUP BY t.category_id, c.name
     ORDER BY used_count DESC, t.category_id ASC
     LIMIT 1`,
    [userId, userId, normMemo, normMemo],
  );
  if (!Array.isArray(fuzzyRows) || fuzzyRows.length === 0) return null;
  const top = fuzzyRows[0];
  return {
    id: Number(top.category_id),
    name: String(top.name),
    source: "history",
  };
}

async function suggestExpenseCategoryForReceipt(pool, userId, catWhere, txWhere, vendor, items) {
  const fromHistory = await suggestExpenseCategoryFromHistory(pool, userId, txWhere, vendor);
  if (fromHistory?.id) return fromHistory;

  const corpus = normalizeKeyword(`${vendor ?? ""} ${(items ?? []).map((x) => x?.name ?? "").join(" ")}`);
  if (!corpus) return null;
  const [rows] = await pool.query(
    `SELECT c.id, c.name
     FROM categories c
     WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'
     ORDER BY c.sort_order, c.id`,
    [userId, userId],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const tagScore = {};
  for (const [tag, words] of Object.entries(RECEIPT_CATEGORY_KEYWORDS)) {
    const score = words.reduce((acc, w) => (corpus.includes(normalizeKeyword(w)) ? acc + 1 : acc), 0);
    if (score > 0) tagScore[tag] = score;
  }

  let best = null;
  for (const r of rows) {
    const tag = tagFromCategoryName(r.name);
    const score = tag ? (tagScore[tag] ?? 0) : 0;
    if (!best || score > best.score) {
      best = { id: Number(r.id), name: String(r.name), score };
    }
  }
  if (!best || best.score <= 0) return null;
  return { id: best.id, name: best.name, source: "keywords" };
}

function tokenizeMemo(text) {
  const s = normalizeKeyword(text);
  if (!s) return [];
  const chunks = s
    .split(/[\/・,，\-_()\[\]【】]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (chunks.length > 0) return chunks;
  return [s];
}

async function suggestExpenseCategoryForMemo(pool, userId, catWhere, txWhere, memo) {
  const vendor = String(memo ?? "").trim();
  if (!vendor) return null;
  const fromHistory = await suggestExpenseCategoryFromHistory(pool, userId, txWhere, vendor);
  if (fromHistory?.id) return fromHistory;
  const tokens = tokenizeMemo(vendor).map((name) => ({ name, amount: null }));
  return suggestExpenseCategoryForReceipt(pool, userId, catWhere, txWhere, vendor, tokens);
}


function ymBounds(yearMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = `${y}-${String(mo).padStart(2, "0")}-01`;
  const last = new Date(y, mo, 0).getDate();
  const to = `${y}-${String(mo).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

async function ensureAdmin(pool, userId) {
  const [rows] = await pool.query(
    `SELECT id, is_admin FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!user) return { ok: false, status: 401, body: { error: "認証ユーザーが見つかりません" } };
  if (Number(user.is_admin) !== 1) {
    return { ok: false, status: 403, body: { error: "管理者権限が必要です" } };
  }
  return { ok: true };
}

function generateAdminTempPassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += chars[crypto.randomInt(chars.length)];
  }
  return out;
}

/**
 * @param {{ method: string, path: string, queryStringParameters?: Record<string,string>|null, body?: string|null, headers?: Record<string, string> }} req
 * @param {{ skipCors?: boolean }} [options]
 */
export async function handleApiRequest(req, options = {}) {
  const { skipCors = false } = options;
  const method = req.method.toUpperCase();
  const path = stripApiPathPrefix(req.path.split("?")[0] || "/");
  const hdrs = req.headers;

  if (method === "OPTIONS") {
    const cors = skipCors ? {} : buildCorsHeaders(hdrs);
    return { statusCode: 204, headers: { ...cors }, body: "" };
  }

  try {
    const authRes = await tryAuthRoutes(req, {
      json,
      hdrs,
      skipCors,
    });
    if (authRes) return authRes;

    if (routeKey(method, path) === "GET /") {
      return json(
        200,
        {
          service: "kakeibo-api",
          message:
            "API は稼働中です。認証: POST /auth/login（JWT）。ヘルス: GET /health",
          endpoints: {
            health: "/health",
            auth: "/auth/login",
            transactions: "/transactions",
            summary: "/summary/month",
          },
        },
        hdrs,
        skipCors,
      );
    }

    {
      const rk = routeKey(method, path);
      const healthGetOrHead = rk === "GET /health" || rk === "HEAD /health";
      if (healthGetOrHead) {
        const rdsHost = String(process.env.RDS_HOST || "").trim();
        if (!rdsHost) {
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 503, headers: { ...cors }, body: "" };
          }
          return json(
            503,
            {
              error: "DatabaseNotConfigured",
              detail:
                "データベース（RDS）に接続されていません。家計簿 API には MySQL の設定が必要です。",
            },
            hdrs,
            skipCors,
          );
        }
        try {
          await pingDatabase();
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 200, headers: { ...cors }, body: "" };
          }
          return json(200, { ok: true, database: "up" }, hdrs, skipCors);
        } catch (e) {
          logError("health.db", e, { method, path });
          const o = e && typeof e === "object" ? e : {};
          const code =
            o.code ?? (o.errno != null ? `errno_${o.errno}` : "UNKNOWN");
          const sqlMessage =
            typeof o.sqlMessage === "string" ? o.sqlMessage : undefined;
          const verbose =
            process.env.NODE_ENV === "development" ||
            process.env.HEALTH_VERBOSE === "true";
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 503, headers: { ...cors }, body: "" };
          }
          return json(
            503,
            {
              ok: false,
              error: "DatabaseUnavailable",
              code: String(code),
              ...(sqlMessage ? { sqlMessage } : {}),
              hint:
                "RDS の環境変数・VPC コネクタ・セキュリティグループを確認してください。",
              ...(verbose && e instanceof Error ? { message: e.message } : {}),
            },
            hdrs,
            skipCors,
          );
        }
      }
    }

    if (!isRdsConfigured()) {
      return json(
        503,
        {
          error: "DatabaseNotConfigured",
          detail:
            "データベース（RDS）に接続されていません。家計簿 API には MySQL の設定が必要です。",
        },
        hdrs,
        skipCors,
      );
    }

    const pool = getPool();

    const userId = resolveUserId(hdrs);
    if (!userId) {
      return json(
        401,
        {
          error: "認証されていません",
          detail: "Authorization: Bearer <JWT> が必要です（開発時のみ ALLOW_X_USER_ID=true で X-User-Id 可）",
        },
        hdrs,
        skipCors,
      );
    }

    const q = req.queryStringParameters || {};
    const familyId = await getDefaultFamilyId(pool, userId);

    const catWhere = `(c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (c.family_id IS NULL AND c.user_id = ?))`;
    const txWhere = `(t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (t.family_id IS NULL AND t.user_id = ?))`;

    const normPath = path.replace(/\/$/, "") || "/";
    const txOneMatch = /^\/transactions\/(\d+)$/.exec(normPath);
    const adminUserOneMatch = /^\/admin\/users\/(\d+)$/.exec(normPath);
    const adminUserResetPasswordMatch = /^\/admin\/users\/(\d+)\/reset-password$/.exec(normPath);

    if (txOneMatch && method === "PATCH") {
      const txId = Number(txOneMatch[1], 10);
      const b = JSON.parse(req.body || "{}");
      const [[existing]] = await pool.query(
        `SELECT id FROM transactions t WHERE t.id = ? AND (${txWhere})`,
        [txId, userId, userId],
      );
      if (!existing) {
        return json(404, { error: "見つかりません" }, hdrs, skipCors);
      }
      const fields = [];
      const params = [];
      if (b.kind === "income" || b.kind === "expense") {
        fields.push("kind = ?");
        params.push(b.kind);
      }
      if (b.amount != null && b.amount !== "") {
        const amt = Number(b.amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return json(400, { error: "金額は正の数である必要があります" }, hdrs, skipCors);
        }
        fields.push("amount = ?");
        params.push(amt);
      }
      if (b.transaction_date != null && b.transaction_date !== "") {
        fields.push("transaction_date = ?");
        params.push(String(b.transaction_date).slice(0, 10));
      }
      if (Object.prototype.hasOwnProperty.call(b, "memo")) {
        fields.push("memo = ?");
        params.push(b.memo == null || b.memo === "" ? null : String(b.memo));
      }
      if (Object.prototype.hasOwnProperty.call(b, "category_id")) {
        let cid = null;
        if (b.category_id != null && b.category_id !== "") {
          cid = Number(b.category_id);
          if (!Number.isFinite(cid)) {
            return json(400, { error: "category_id が不正です" }, hdrs, skipCors);
          }
        }
        fields.push("category_id = ?");
        params.push(cid);
      }
      if (fields.length === 0) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      params.push(txId);
      await pool.query(
        `UPDATE transactions t SET ${fields.join(", ")} WHERE t.id = ? AND (${txWhere})`,
        [...params, userId, userId],
      );
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (txOneMatch && method === "DELETE") {
      const txId = Number(txOneMatch[1], 10);
      const [delRes] = await pool.query(
        `DELETE t FROM transactions t WHERE t.id = ? AND (${txWhere})`,
        [txId, userId, userId],
      );
      if (!delRes.affectedRows) {
        return json(404, { error: "見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (routeKey(method, path) === "GET /admin/users") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const [rows] = await pool.query(
        `SELECT
           u.id,
           u.email,
           u.login_name,
           u.display_name,
           u.is_admin,
           u.created_at,
           u.updated_at,
           u.last_login_at,
           u.default_family_id,
           f.name AS family_name,
           (
             SELECT GROUP_CONCAT(
               CONCAT(
                 COALESCE(NULLIF(TRIM(u2.display_name), ''), u2.email),
                 ' (', fm2.role, ')'
               )
               ORDER BY fm2.id
               SEPARATOR ' / '
             )
             FROM family_members fm2
             JOIN users u2 ON u2.id = fm2.user_id
             WHERE u.default_family_id IS NOT NULL
               AND fm2.family_id = u.default_family_id
           ) AS family_peers
         FROM users u
         LEFT JOIN families f ON f.id = u.default_family_id
         ORDER BY u.id ASC
         LIMIT 1000`,
      );
      const items = (Array.isArray(rows) ? rows : []).map((r) => ({
        id: Number(r.id),
        email: String(r.email ?? ""),
        login_name: r.login_name == null ? null : String(r.login_name),
        display_name: r.display_name == null ? null : String(r.display_name),
        isAdmin: Number(r.is_admin) === 1,
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
        last_login_at: r.last_login_at ?? null,
        default_family_id: r.default_family_id ?? null,
        family_name: r.family_name == null ? null : String(r.family_name),
        family_peers: r.family_peers == null || r.family_peers === "" ? null : String(r.family_peers),
      }));
      return json(200, { items }, hdrs, skipCors);
    }

    if (adminUserOneMatch && method === "PATCH") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserOneMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(b, "isAdmin")) {
        if (typeof b.isAdmin !== "boolean") {
          return json(400, { error: "isAdmin は boolean で指定してください" }, hdrs, skipCors);
        }
        updates.push("is_admin = ?");
        params.push(b.isAdmin ? 1 : 0);
      }
      if (Object.prototype.hasOwnProperty.call(b, "displayName")) {
        const rawName = b.displayName == null ? "" : String(b.displayName).trim();
        if (rawName.length > 100) {
          return json(400, { error: "displayName は100文字以内で指定してください" }, hdrs, skipCors);
        }
        updates.push("display_name = ?");
        params.push(rawName === "" ? null : rawName);
      }
      if (updates.length === 0) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      const [[exists]] = await pool.query(
        `SELECT id, is_admin FROM users WHERE id = ?`,
        [targetUserId],
      );
      if (!exists) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      if (
        Object.prototype.hasOwnProperty.call(b, "isAdmin") &&
        b.isAdmin === false &&
        Number(exists.is_admin) === 1
      ) {
        const [[cntRow]] = await pool.query(
          `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`,
        );
        if (Number(cntRow?.c) <= 1) {
          return json(400, { error: "最後の管理者の権限は外せません" }, hdrs, skipCors);
        }
      }
      await pool.query(
        `UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
        [...params, targetUserId],
      );
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (adminUserResetPasswordMatch && method === "POST") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserResetPasswordMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      const tempPassword = generateAdminTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      const [upd] = await pool.query(
        `UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
        [passwordHash, targetUserId],
      );
      if (!upd?.affectedRows) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      await pool.query(
        `DELETE FROM password_reset_tokens WHERE user_id = ?`,
        [targetUserId],
      );
      return json(
        200,
        {
          ok: true,
          temporaryPassword: tempPassword,
          message: "一時パスワードを発行しました。ログイン後に変更してください。",
        },
        hdrs,
        skipCors,
      );
    }

    if (adminUserOneMatch && method === "DELETE") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserOneMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      if (targetUserId === userId) {
        return json(400, { error: "自分自身は削除できません" }, hdrs, skipCors);
      }
      const [[target]] = await pool.query(
        `SELECT id, is_admin FROM users WHERE id = ?`,
        [targetUserId],
      );
      if (!target) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      if (Number(target.is_admin) === 1) {
        const [[cntRow]] = await pool.query(
          `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`,
        );
        if (Number(cntRow?.c) <= 1) {
          return json(400, { error: "最後の管理者は削除できません" }, hdrs, skipCors);
        }
      }
      const [del] = await pool.query(`DELETE FROM users WHERE id = ?`, [targetUserId]);
      if (!del?.affectedRows) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    switch (routeKey(method, path)) {
      case "GET /categories": {
        const [rows] = await pool.query(
          `SELECT c.id, c.parent_id, c.name, c.kind, c.color_hex, c.sort_order, c.is_archived, c.created_at, c.updated_at
           FROM categories c
           WHERE ${catWhere} AND c.is_archived = 0
           ORDER BY c.kind, c.sort_order, c.id`,
          [userId, userId],
        );
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /categories": {
        const b = JSON.parse(req.body || "{}");
        const [r] = await pool.query(
          `INSERT INTO categories (user_id, family_id, parent_id, name, kind, color_hex, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
            b.parent_id ?? null,
            b.name,
            b.kind ?? "expense",
            b.color_hex ?? null,
            b.sort_order ?? 0,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      case "GET /transactions": {
        const from = q.from;
        const to = q.to;
        let sql = `SELECT t.id, t.account_id, t.category_id, t.kind, t.amount, t.transaction_date, t.memo, t.created_at, t.updated_at, t.user_id
                   FROM transactions t
                   WHERE ${txWhere}`;
        const params = [userId, userId];
        if (from) {
          sql += ` AND t.transaction_date >= ?`;
          params.push(from);
        }
        if (to) {
          sql += ` AND t.transaction_date <= ?`;
          params.push(to);
        }
        sql += ` ORDER BY t.transaction_date DESC, t.id DESC LIMIT 500`;
        const [rows] = await pool.query(sql, params);
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /transactions": {
        const b = JSON.parse(req.body || "{}");
        const [r] = await pool.query(
          `INSERT INTO transactions
           (user_id, family_id, account_id, category_id, kind, amount, transaction_date, memo, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
            b.account_id ?? null,
            b.category_id ?? null,
            b.kind ?? "expense",
            b.amount,
            b.transaction_date,
            b.memo ?? null,
            b.external_id ?? null,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      case "POST /transactions/delete": {
        const b = JSON.parse(req.body || "{}");
        const txId = Number(b.id);
        if (!Number.isFinite(txId) || txId <= 0) {
          return json(400, { error: "id が不正です" }, hdrs, skipCors);
        }
        const [delRes] = await pool.query(
          `DELETE t FROM transactions t WHERE t.id = ? AND (${txWhere})`,
          [txId, userId, userId],
        );
        if (!delRes.affectedRows) {
          return json(404, { error: "見つかりません" }, hdrs, skipCors);
        }
        return json(200, { ok: true }, hdrs, skipCors);
      }

      case "GET /summary/month": {
        const ym = q.year_month || q.yearMonth;
        const bounds = ymBounds(ym);
        if (!bounds) {
          return json(
            400,
            { error: "year_month=YYYY-MM が必要です" },
            hdrs,
            skipCors,
          );
        }
        const { from, to } = bounds;
        const [expRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'expense'
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [userId, userId, from, to],
        );
        const [incRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'income'
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [userId, userId, from, to],
        );
        const [[sumE]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'expense'`,
          [userId, userId, from, to],
        );
        const [[sumI]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'income'`,
          [userId, userId, from, to],
        );
        return json(
          200,
          {
            year_month: ym,
            from,
            to,
            expenseTotal: sumE.total,
            incomeTotal: sumI.total,
            expensesByCategory: expRows,
            incomesByCategory: incRows,
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /import/csv": {
        const b = JSON.parse(req.body || "{}");
        const text = String(b.csvText || "");
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        let inserted = 0;
        for (const line of lines) {
          const parts = line.split(/[,，\t]/).map((s) => s.trim());
          if (parts.length < 2) continue;
          const dateStr = parts[0].replace(/\//g, "-");
          const amount = Number.parseFloat(parts[1].replace(/[,円]/g, ""));
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Number.isFinite(amount)) {
            continue;
          }
          const memo = parts.slice(2).join(" ") || "CSV取込";
          await pool.query(
            `INSERT INTO transactions (user_id, family_id, kind, amount, transaction_date, memo)
             VALUES (?, ?, 'expense', ?, ?, ?)`,
            [userId, familyId, Math.abs(amount), dateStr, memo],
          );
          inserted += 1;
        }
        return json(
          200,
          {
            ok: true,
            inserted,
            message:
              "汎用CSV（日付,金額,メモ…）を取り込みました。銀行独自形式は今後拡張予定です。",
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /receipts/parse": {
        const b = JSON.parse(req.body || "{}");
        if (b.imageBase64 == null || typeof b.imageBase64 !== "string") {
          return json(
            400,
            {
              error: "InvalidRequest",
              detail:
                "imageBase64（JPEG/PNG 等の base64、または data URL）が必要です。",
            },
            hdrs,
            skipCors,
          );
        }
        try {
          const buf = decodeImageBuffer(b.imageBase64);
          const result = await analyzeReceiptImageBytes(buf, { logError });
          const suggestedCategory = await suggestExpenseCategoryForReceipt(
            pool,
            userId,
            catWhere,
            txWhere,
            result?.summary?.vendorName ?? "",
            result?.items ?? [],
          );
          return json(
            200,
            {
              ok: true,
              demo: false,
              summary: result.summary,
              items: result.items,
              notice: result.notice,
              expenseIndex: result.expenseIndex,
              suggestedCategoryId: suggestedCategory?.id ?? null,
              suggestedCategoryName: suggestedCategory?.name ?? null,
              suggestedCategorySource: suggestedCategory?.source ?? null,
            },
            hdrs,
            skipCors,
          );
        } catch (e) {
          const status =
            e &&
            typeof e === "object" &&
            "statusCode" in e &&
            Number.isFinite(Number(e.statusCode))
              ? Number(e.statusCode)
              : 500;
          const code =
            e && typeof e === "object" && "code" in e && e.code
              ? String(e.code)
              : "ReceiptParseError";
          logError("receipts.parse", e, { code, status });
          // Textract の一時障害時は手入力フローを継続できるよう 200 で返す。
          if (code === "TextractTimeout" || code === "TextractNetworkBusy") {
            return json(
              200,
              {
                ok: true,
                demo: false,
                summary: { vendorName: null, totalAmount: null, date: null, fieldConfidence: {} },
                items: [],
                notice:
                  "自動解析は混雑中です。店舗名・金額・日付を手入力してそのまま登録できます。",
                expenseIndex: null,
              },
              hdrs,
              skipCors,
            );
          }
          return json(
            status,
            {
              error: code,
              detail:
                e instanceof Error
                  ? e.message
                  : typeof e === "string"
                    ? e
                    : "レシート解析に失敗しました。",
            },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /receipts/reclassify-uncategorized": {
        const b = JSON.parse(req.body || "{}");
        const limitRaw = Number.parseInt(String(b.limit ?? "100"), 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(limitRaw, 500)
          : 100;

        const [rows] = await pool.query(
          `SELECT t.id, t.memo
           FROM transactions t
           WHERE ${txWhere}
             AND t.kind = 'expense'
             AND t.category_id IS NULL
             AND t.memo IS NOT NULL
             AND TRIM(t.memo) <> ''
           ORDER BY t.transaction_date DESC, t.id DESC
           LIMIT ?`,
          [userId, userId, limit],
        );

        let updated = 0;
        for (const r of rows) {
          const txId = Number(r.id);
          const memo = String(r.memo ?? "");
          if (!Number.isFinite(txId) || !memo.trim()) continue;
          const suggestion = await suggestExpenseCategoryForMemo(
            pool,
            userId,
            catWhere,
            txWhere,
            memo,
          );
          if (!suggestion?.id) continue;
          const [upd] = await pool.query(
            `UPDATE transactions t
             SET t.category_id = ?
             WHERE t.id = ? AND (${txWhere}) AND t.category_id IS NULL`,
            [suggestion.id, txId, userId, userId],
          );
          if (upd?.affectedRows) updated += 1;
        }

        return json(
          200,
          {
            ok: true,
            scanned: Array.isArray(rows) ? rows.length : 0,
            updated,
            limit,
          },
          hdrs,
          skipCors,
        );
      }

      default:
        return json(404, { error: "Not Found", path, method }, hdrs, skipCors);
    }
  } catch (e) {
    if (e && typeof e === "object" && e.code === "DATABASE_NOT_CONFIGURED") {
      return json(
        503,
        {
          error: "DatabaseNotConfigured",
          detail: e instanceof Error ? e.message : String(e),
        },
        hdrs,
        skipCors,
      );
    }
    logError("api.unhandled", e, { method, path });
    return json(
      500,
      {
        error: "InternalError",
        message:
          process.env.NODE_ENV === "development"
            ? String(e.message)
            : undefined,
      },
      hdrs,
      skipCors,
    );
  }
}

export { resolveUserId };
