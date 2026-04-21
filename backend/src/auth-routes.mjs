import crypto from "node:crypto";
import { stripApiPathPrefix } from "./api-path.mjs";
import {
  hashPassword,
  resolveUserId,
  signUserToken,
  validatePassword,
  verifyPassword,
} from "./auth-logic.mjs";
import { getPool } from "./db.mjs";
import { seedDefaultCategoriesIfEmpty } from "./category-defaults.mjs";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { canAccessFamilyChat, SINGLE_FAMILY_CHAT_ID } from "./family-chat-access.mjs";
import {
  bodyContainsSubscriptionMutationFields,
  buildUserSubscriptionApiFields,
  deriveSubscriptionStatusFromDbRow,
  getEffectiveSubscriptionStatus,
  mergeAuthMeSubscriptionWithPreferredFamily,
  userHasPremiumSubscriptionAccess,
} from "./subscription-logic.mjs";

const FAM_JOIN_ON_U = sqlUserFamilyIdExpr("u");

/** このモジュールが処理するパス（ここに無いリクエストは getPool せず null を返す） */
const AUTH_ROUTE_KEYS = new Set([
  "POST /auth/register",
  "POST /auth/login",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
  "GET /auth/me",
  "PATCH /auth/me/kid-theme",
  "GET /families/members",
  "POST /families/invite",
  "GET /families/children",
  "POST /families/children",
  "PATCH /families/children/:id",
  "DELETE /families/children/:id",
  "GET /families/children/search",
  "POST /families/children/link-existing",
  "POST /auth/child-session",
]);

const RETRYABLE_DB_CODES = new Set([
  "EBUSY",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
]);

function isRetryableDbError(e) {
  if (!e || typeof e !== "object") return false;
  const code = e.code ? String(e.code) : "";
  const syscall = e.syscall ? String(e.syscall) : "";
  return RETRYABLE_DB_CODES.has(code) || syscall.includes("getaddrinfo");
}

function isDuplicateKeyError(e) {
  if (!e || typeof e !== "object") return false;
  const code = e.code ? String(e.code) : "";
  const errno = Number(e.errno);
  return code === "ER_DUP_ENTRY" || errno === 1062;
}

function logError(event, e, extra = {}) {
  const payload = {
    level: "error",
    event,
    code: e?.code,
    errno: e?.errno,
    syscall: e?.syscall,
    hostname: e?.hostname,
    message: e?.message,
    ...extra,
  };
  console.error(JSON.stringify(payload));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDbRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryableDbError(e) || i === attempts) throw e;
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "db.retry",
          label,
          attempt: i,
          code: e?.code,
          syscall: e?.syscall,
          message: e?.message,
        }),
      );
      const base = Number(process.env.DB_RETRY_BASE_MS || "500");
      const max = Number(process.env.DB_RETRY_MAX_MS || "5000");
      const backoff = Math.min(base * 2 ** (i - 1), max);
      const jitter = Math.floor(Math.random() * 200);
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

function routeKey(method, path) {
  const p = path.replace(/\/$/, "") || "/";
  return `${method} ${p}`;
}

function isErBadFieldError(e) {
  if (!e || typeof e !== "object") return false;
  const code = String(e.code || "");
  const errno = Number(e.errno);
  return code === "ER_BAD_FIELD_ERROR" || errno === 1054;
}

function normalizeGradeGroup(raw) {
  if (raw == null) return null;
  const s0 =
    typeof Buffer !== "undefined" && Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const s = s0.trim();
  if (s === "1-2" || s === "3-4" || s === "5-6") return s;
  if (s === "1-2年生") return "1-2";
  if (s === "3-4年生") return "3-4";
  if (s === "5-6年生") return "5-6";
  return null;
}

async function queryChildProfilesByParent(pool, parentUserId) {
  const queries = [
    `SELECT id, display_name, grade_group, kid_theme
     FROM users
     WHERE parent_id = ? AND COALESCE(is_child, 0) = 1
     ORDER BY id ASC`,
    `SELECT id, display_name, NULL AS grade_group, kid_theme
     FROM users
     WHERE parent_id = ?
       AND UPPER(TRIM(COALESCE(family_role, 'MEMBER'))) = 'KID'
     ORDER BY id ASC`,
    `SELECT id, display_name, NULL AS grade_group, NULL AS kid_theme
     FROM users
     WHERE parent_id = ?
     ORDER BY id ASC`,
    `SELECT u.id, u.display_name, NULL AS grade_group, NULL AS kid_theme
     FROM family_members fm_self
     INNER JOIN family_members fm_kid ON fm_kid.family_id = fm_self.family_id
     INNER JOIN users u ON u.id = fm_kid.user_id
     WHERE fm_self.user_id = ?
       AND fm_kid.user_id <> ?
       AND UPPER(TRIM(COALESCE(u.family_role, 'MEMBER'))) = 'KID'
     GROUP BY u.id, u.display_name
     ORDER BY u.id ASC`,
  ];
  let lastErr;
  for (const sql of queries) {
    try {
      const usesSelfAndKid = sql.includes("fm_kid.user_id <> ?");
      const params = usesSelfAndKid ? [parentUserId, parentUserId] : [parentUserId];
      const [rows] = await pool.query(sql, params);
      return rows;
    } catch (e) {
      lastErr = e;
      if (!isErBadFieldError(e)) throw e;
    }
  }
  if (isErBadFieldError(lastErr)) return [];
  throw lastErr;
}

async function queryUserByEmailForChildSearch(pool, emailLower) {
  const queries = [
    `SELECT id, email, display_name, COALESCE(is_child, 0) AS is_child, parent_id, grade_group
     FROM users
     WHERE LOWER(email) = ?
     LIMIT 1`,
    `SELECT id, email, display_name, 0 AS is_child, parent_id, NULL AS grade_group
     FROM users
     WHERE LOWER(email) = ?
     LIMIT 1`,
  ];
  let lastErr;
  for (const sql of queries) {
    try {
      const [rows] = await pool.query(sql, [emailLower]);
      return rows;
    } catch (e) {
      lastErr = e;
      if (!isErBadFieldError(e)) throw e;
    }
  }
  throw lastErr;
}

/**
 * GET /auth/me 用: users.family_role を直接取得する。
 * queryMeUserRow がフォールバッククエリに落ちたとき SELECT に family_role が無く MEMBER 扱いになるのを防ぐ。
 * @returns {Promise<"ADMIN" | "MEMBER" | "KID">}
 */
function coerceMysqlEnumToUpperString(v) {
  if (v == null) return "";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
    return v.toString("utf8").trim().toUpperCase();
  }
  return String(v).trim().toUpperCase();
}

async function fetchUserFamilyRoleUpperForMe(pool, userId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COALESCE(family_role, 'MEMBER') AS fr FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    const v = coerceMysqlEnumToUpperString(row?.fr ?? "MEMBER") || "MEMBER";
    if (v === "KID" || v === "ADMIN") return v;
    return "MEMBER";
  } catch (e) {
    if (isErBadFieldError(e)) return "MEMBER";
    throw e;
  }
}

/**
 * 子ども向けきせかえテーマ（users.kid_theme）。未設定は null（フロントで blue 相当）。
 * @returns {Promise<"pink"|"lavender"|"pastel_yellow"|"mint_green"|"floral"|"blue"|"navy"|"dino_green"|"space_black"|"sky_red"|null>}
 */
async function fetchUserKidTheme(pool, userId) {
  try {
    const [[row]] = await pool.query(`SELECT kid_theme AS kt FROM users WHERE id = ? LIMIT 1`, [
      userId,
    ]);
    const raw = row?.kt;
    if (raw == null || String(raw).trim() === "") return null;
    const s0 =
      typeof Buffer !== "undefined" && Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const s = s0.trim().toLowerCase();
    if (s === "pink") return "pink";
    if (s === "lavender") return "lavender";
    if (s === "pastel_yellow") return "pastel_yellow";
    if (s === "mint_green") return "mint_green";
    if (s === "floral") return "floral";
    if (s === "blue") return "blue";
    if (s === "navy") return "navy";
    if (s === "dino_green") return "dino_green";
    if (s === "space_black") return "space_black";
    if (s === "sky_red") return "sky_red";
    return null;
  } catch (e) {
    if (isErBadFieldError(e)) return null;
    throw e;
  }
}

function normalizeKidThemeInput(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "pink") return "pink";
  if (s === "lavender") return "lavender";
  if (s === "pastel_yellow") return "pastel_yellow";
  if (s === "mint_green") return "mint_green";
  if (s === "floral") return "floral";
  if (s === "blue") return "blue";
  if (s === "navy") return "navy";
  if (s === "dino_green") return "dino_green";
  if (s === "space_black") return "space_black";
  if (s === "sky_red") return "sky_red";
  return null;
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {string[]} queries
 * @param {unknown[]} params
 */
async function queryWithColumnFallback(pool, queries, params) {
  let lastErr;
  for (const sql of queries) {
    try {
      const [rows] = await pool.query(sql, params);
      return { rows };
    } catch (e) {
      lastErr = e;
      if (!isErBadFieldError(e)) throw e;
    }
  }
  throw lastErr;
}

let warnedSubscriptionColumnMissing = false;
function warnSubscriptionColumnMissingOnce() {
  if (warnedSubscriptionColumnMissing) return;
  warnedSubscriptionColumnMissing = true;
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "auth.subscription_status_column_missing",
      detail:
        "users.subscription_status がありません。db/migration_v8_users_subscription_status.sql を適用してください。暫定で inactive としてログインを継続します。",
    }),
  );
}

/**
 * @returns {Promise<{ rows: unknown[] }>}
 */
async function queryLoginUserRow(pool, login) {
  const params = [login, login];
  const w = `WHERE LOWER(email) = ? OR (login_name IS NOT NULL AND LOWER(login_name) = ?)`;
  const wAliased = `WHERE (LOWER(u.email) = ? OR (u.login_name IS NOT NULL AND LOWER(u.login_name) = ?))`;
  const { rows } = await queryWithColumnFallback(
    pool,
    [
      `SELECT u.id, u.email, u.password_hash, u.is_admin,
        COALESCE(u.is_child, 0) AS is_child,
        u.parent_id,
        u.grade_group,
        COALESCE(f.subscription_status, u.subscription_status) AS subscription_status,
        u.is_premium,
        COALESCE(f.subscription_period_end_at, u.subscription_period_end_at) AS subscription_period_end_at,
        COALESCE(f.subscription_cancel_at_period_end, u.subscription_cancel_at_period_end) AS subscription_cancel_at_period_end,
        f.stripe_subscription_id AS stripe_subscription_id
       FROM users u
       LEFT JOIN families f ON f.id = ${FAM_JOIN_ON_U}
       ${wAliased}`,
      `SELECT id, email, password_hash, is_admin, is_child, parent_id, grade_group, subscription_status, is_premium, subscription_period_end_at, subscription_cancel_at_period_end, stripe_subscription_id FROM users ${w}`,
      `SELECT id, email, password_hash, is_admin, subscription_status, is_premium FROM users ${w}`,
      `SELECT id, email, password_hash, is_admin, subscription_status FROM users ${w}`,
      `SELECT id, email, password_hash, is_admin FROM users ${w}`,
    ],
    params,
  );
  if (
    rows.length > 0 &&
    rows[0] &&
    typeof rows[0] === "object" &&
    !Object.prototype.hasOwnProperty.call(rows[0], "subscription_status")
  ) {
    warnSubscriptionColumnMissingOnce();
  }
  return { rows };
}

/**
 * @returns {Promise<{ rows: unknown[] }>}
 */
async function queryMeUserRow(pool, uid) {
  const { rows } = await queryWithColumnFallback(
    pool,
    [
      `SELECT u.id, u.email, u.login_name, u.display_name, u.default_family_id, u.is_admin,
        COALESCE(u.family_role, 'MEMBER') AS family_role,
        COALESCE(u.is_child, 0) AS is_child,
        u.parent_id,
        u.grade_group,
        COALESCE(f.subscription_status, u.subscription_status) AS subscription_status,
        u.is_premium,
        COALESCE(f.subscription_period_end_at, u.subscription_period_end_at) AS subscription_period_end_at,
        COALESCE(f.subscription_cancel_at_period_end, u.subscription_cancel_at_period_end) AS subscription_cancel_at_period_end,
        f.stripe_subscription_id AS stripe_subscription_id
       FROM users u
       LEFT JOIN families f ON f.id = ${FAM_JOIN_ON_U}
       WHERE u.id = ?`,
      `SELECT id, email, login_name, display_name, default_family_id, is_admin, is_child, parent_id, grade_group, subscription_status, is_premium, subscription_period_end_at, subscription_cancel_at_period_end, stripe_subscription_id FROM users WHERE id = ?`,
      `SELECT id, email, login_name, display_name, default_family_id, is_admin, subscription_status, is_premium FROM users WHERE id = ?`,
      `SELECT id, email, login_name, display_name, default_family_id, is_admin, subscription_status FROM users WHERE id = ?`,
      `SELECT id, email, login_name, display_name, default_family_id, is_admin FROM users WHERE id = ?`,
    ],
    [uid],
  );
  if (
    rows.length > 0 &&
    rows[0] &&
    typeof rows[0] === "object" &&
    !Object.prototype.hasOwnProperty.call(rows[0], "subscription_status")
  ) {
    warnSubscriptionColumnMissingOnce();
  }
  return { rows };
}

export async function getDefaultFamilyId(pool, userId) {
  const [rows] = await pool.query(
    `SELECT ${FAM_JOIN_ON_U} AS fid
     FROM users u WHERE u.id = ?`,
    [userId],
  );
  return rows[0]?.fid ?? null;
}

/** 家族チャット・/auth/me の familyId: members に無い家族 ADMIN / サイト管理者向けに SINGLE_FAMILY_CHAT_ID へフォールバック */
export async function resolveFamilyIdWithChatFallback(pool, userId) {
  const base = await getDefaultFamilyId(pool, userId);
  if (base != null) return base;
  if (await canAccessFamilyChat(pool, userId, SINGLE_FAMILY_CHAT_ID)) {
    return SINGLE_FAMILY_CHAT_ID;
  }
  return null;
}

async function getPreferredFamilySubscriptionRow(pool, userId) {
  const [rows] = await pool.query(
    `SELECT
       f.subscription_status,
       f.subscription_period_end_at,
       f.subscription_cancel_at_period_end,
       f.stripe_subscription_id
     FROM family_members fm
     JOIN families f ON f.id = fm.family_id
     WHERE fm.user_id = ?
     ORDER BY
       CASE
         WHEN LOWER(TRIM(COALESCE(f.subscription_status, ''))) IN ('active','trialing','past_due','admin_free','admin_granted') THEN 0
         WHEN TRIM(COALESCE(f.stripe_customer_id, '')) <> '' THEN 1
         ELSE 2
       END,
       COALESCE(f.updated_at, f.created_at, '1970-01-01') DESC,
       fm.id ASC
     LIMIT 1`,
    [userId],
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * @returns {Promise<{ statusCode, headers, body }|null>}
 */
export async function tryAuthRoutes(req, ctx) {
  const { json, hdrs, skipCors } = ctx;
  const method = req.method.toUpperCase();
  const path = stripApiPathPrefix(req.path.split("?")[0] || "/");
  const key = routeKey(method, path);
  const childOneMatch = /^\/families\/children\/(\d+)$/.exec(path);

  const isChildOneRoute = childOneMatch != null && (method === "PATCH" || method === "DELETE");
  if (!AUTH_ROUTE_KEYS.has(key) && !isChildOneRoute) {
    return null;
  }

  if (!String(process.env.RDS_HOST || "").trim()) {
    return json(
      503,
      {
        error: "DatabaseNotConfigured",
        detail:
          "データベース（RDS）に接続されていません。ログイン・新規登録には MySQL（RDS）の接続設定が必要です。管理者: Terraform の app_secret_arns に RDS_* を追加し ECS を再デプロイしてください。",
      },
      hdrs,
      skipCors,
    );
  }

  try {
    const pool = getPool();
    if (key === "POST /auth/register") {
      const b = JSON.parse(req.body || "{}");
      if (bodyContainsSubscriptionMutationFields(b)) {
        return json(
          400,
          {
            error: "InvalidRequest",
            detail: "サブスクリプション状態は管理者のみが変更できます",
          },
          hdrs,
          skipCors,
        );
      }
      const email = String(b.email || "")
        .trim()
        .toLowerCase();
      const loginRaw = b.login_name != null ? String(b.login_name).trim() : "";
      const loginName = loginRaw.length > 0 ? loginRaw : null;
      const password = String(b.password || "");
      const displayRaw = b.display_name != null ? String(b.display_name).trim() : "";
      const displayName = displayRaw.length > 0 ? displayRaw : null;
      const inviteToken = b.invite_token
        ? String(b.invite_token).trim()
        : "";

      if (!email || !email.includes("@")) {
        return json(400, { error: "メールアドレスが不正です" }, hdrs, skipCors);
      }
      if (!validatePassword(password)) {
        return json(
          400,
          {
            error:
              "パスワードは英数字記号8文字以上としてください。英字・数字・記号をそれぞれ1文字以上含めてください",
          },
          hdrs,
          skipCors,
        );
      }

      const ph = await hashPassword(password);
      const conn = await withDbRetry(
        "auth.register.getConnection",
        () => pool.getConnection(),
        Number(process.env.DB_RETRY_ATTEMPTS || "10"),
      );
      try {
        await conn.beginTransaction();

        const [emailDup] = await conn.query(
          `SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1`,
          [email],
        );
        if (emailDup.length > 0) {
          await conn.rollback();
          return json(
            409,
            {
              error:
                "このメールアドレスは既に登録されています。別のメールアドレスを入力してください。",
            },
            hdrs,
            skipCors,
          );
        }

        if (loginName) {
          const loginLc = loginName.toLowerCase();
          const [loginDup] = await conn.query(
            `SELECT id FROM users WHERE LOWER(email) = ? OR (login_name IS NOT NULL AND LOWER(login_name) = ?) LIMIT 1`,
            [loginLc, loginLc],
          );
          if (loginDup.length > 0) {
            await conn.rollback();
            return json(
              409,
              {
                error:
                  "このログインIDは既に使用されています（他の方のメールアドレスと同じ文字列も使えません）。別のログインIDを入力してください。",
              },
              hdrs,
              skipCors,
            );
          }
        }

        if (displayName) {
          const [dispDup] = await conn.query(
            `SELECT id FROM users WHERE display_name IS NOT NULL AND TRIM(display_name) <> '' AND LOWER(TRIM(display_name)) = LOWER(?) LIMIT 1`,
            [displayName],
          );
          if (dispDup.length > 0) {
            await conn.rollback();
            return json(
              409,
              {
                error:
                  "この表示名は既に使われています。別の表示名を入力してください。",
              },
              hdrs,
              skipCors,
            );
          }
        }

        let ur;
        try {
          [ur] = await conn.query(
            `INSERT INTO users (email, login_name, password_hash, display_name)
             VALUES (?, ?, ?, ?)`,
            [email, loginName, ph, displayName],
          );
        } catch (insErr) {
          if (isDuplicateKeyError(insErr)) {
            await conn.rollback();
            return json(
              409,
              {
                error:
                  "入力したメールアドレス、ログインID、または表示名のいずれかが既に使われています。別の内容を入力してください。",
              },
              hdrs,
              skipCors,
            );
          }
          throw insErr;
        }
        const userId = ur.insertId;
        let familyId = null;
        let role = "owner";

        if (inviteToken) {
          const inviteHash = crypto.createHash("sha256").update(inviteToken).digest("hex");
          const [invRows] = await conn.query(
            `SELECT id, family_id, email
             FROM family_invites
             WHERE token_hash = ? AND expires_at > NOW()
             LIMIT 1`,
            [inviteHash],
          );
          if (invRows.length === 0) {
            await conn.rollback();
            return json(400, { error: "招待リンクが無効または期限切れです" }, hdrs, skipCors);
          }
          const inv = invRows[0];
          const invEmail = inv.email != null ? String(inv.email).trim().toLowerCase() : "";
          if (!invEmail || !invEmail.includes("@")) {
            await conn.rollback();
            return json(400, { error: "招待情報が不正です" }, hdrs, skipCors);
          }
          if (invEmail !== email) {
            await conn.rollback();
            return json(
              400,
              { error: "招待されたメールアドレスと登録メールアドレスが一致しません" },
              hdrs,
              skipCors,
            );
          }
          familyId = inv.family_id;
          role = "member";
          const [[famRow]] = await conn.query(
            `SELECT COUNT(*) AS c FROM family_members WHERE family_id = ?`,
            [familyId],
          );
          if (!famRow || Number(famRow.c) < 1) {
            await conn.rollback();
            return json(400, { error: "招待先の家族が無効です" }, hdrs, skipCors);
          }
          await conn.query("DELETE FROM family_invites WHERE id = ?", [inv.id]);
        } else {
          const internalFamilyName = "夫婦";
          const [fr] = await conn.query("INSERT INTO families (name) VALUES (?)", [
            internalFamilyName,
          ]);
          familyId = fr.insertId;
        }

        await conn.query("UPDATE users SET default_family_id = ? WHERE id = ?", [
          familyId,
          userId,
        ]);
        await conn.query(
          `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, ?)`,
          [familyId, userId, role],
        );

        await conn.commit();

        await seedDefaultCategoriesIfEmpty(pool, userId, familyId);

        await withDbRetry("auth.register.lastLogin", () =>
          pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [userId]),
        );

        const token = signUserToken(userId, email);
        return json(
          201,
          {
            token,
            user: {
              id: userId,
              email,
              familyId,
              isAdmin: false,
              subscriptionStatus: "inactive",
            },
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    if (key === "POST /auth/login") {
      const b = JSON.parse(req.body || "{}");
      if (bodyContainsSubscriptionMutationFields(b)) {
        return json(
          400,
          {
            error: "InvalidRequest",
            detail: "サブスクリプション状態は管理者のみが変更できます",
          },
          hdrs,
          skipCors,
        );
      }
      const login = String(b.login || b.email || "")
        .trim()
        .toLowerCase();
      const password = String(b.password || "");
      if (!login || !password) {
        return json(400, { error: "ログインIDとパスワードを入力してください" }, hdrs, skipCors);
      }

      const { rows } = await withDbRetry(
        "auth.login.queryUser",
        () => queryLoginUserRow(pool, login),
        Number(process.env.DB_RETRY_ATTEMPTS || "10"),
      );
      if (rows.length === 0) {
        return json(401, { error: "ログインに失敗しました" }, hdrs, skipCors);
      }
      const u = rows[0];
      const ok = await verifyPassword(password, u.password_hash);
      if (!ok) {
        return json(
          401,
          { error: "パスワード誤りです。再度入力して下さい。" },
          hdrs,
          skipCors,
        );
      }

      await withDbRetry("auth.login.lastLogin", () =>
        pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [u.id]),
      );

      const token = signUserToken(u.id, u.email);
      const familyId = await resolveFamilyIdWithChatFallback(pool, u.id);
      const familyRole = await fetchUserFamilyRoleUpperForMe(pool, u.id);
      const kidTheme = await fetchUserKidTheme(pool, u.id);
      const famSubLogin = await getPreferredFamilySubscriptionRow(pool, u.id);
      const mergedLogin = mergeAuthMeSubscriptionWithPreferredFamily(u, famSubLogin);
      return json(
        200,
        {
          token,
          user: {
            id: mergedLogin.id,
            email: mergedLogin.email ?? "",
            familyId,
            familyRole,
            kidTheme,
            isChild: Number(mergedLogin.is_child) === 1,
            parentId:
              mergedLogin.parent_id != null && Number.isFinite(Number(mergedLogin.parent_id))
                ? Number(mergedLogin.parent_id)
                : null,
            gradeGroup: normalizeGradeGroup(mergedLogin.grade_group),
            isAdmin: Number(mergedLogin.is_admin) === 1,
            subscriptionStatus: getEffectiveSubscriptionStatus(
              deriveSubscriptionStatusFromDbRow(mergedLogin),
              mergedLogin.id,
            ),
            ...buildUserSubscriptionApiFields(mergedLogin),
            isPremium: userHasPremiumSubscriptionAccess(mergedLogin, u.id),
          },
        },
        hdrs,
        skipCors,
      );
    }

    if (key === "POST /auth/forgot-password") {
      const b = JSON.parse(req.body || "{}");
      if (bodyContainsSubscriptionMutationFields(b)) {
        return json(
          400,
          {
            error: "InvalidRequest",
            detail: "サブスクリプション状態は管理者のみが変更できます",
          },
          hdrs,
          skipCors,
        );
      }
      const email = String(b.email || "")
        .trim()
        .toLowerCase();
      if (!email) {
        return json(400, { error: "メールアドレスを入力してください" }, hdrs, skipCors);
      }

      const [rows] = await pool.query(
        "SELECT id FROM users WHERE email = ? LIMIT 1",
        [email],
      );
      const genericOk = {
        ok: true,
        message:
          "登録がある場合、パスワード再設定用の案内を送信します（メール連携未設定時は開発用レスポンスを参照）。",
      };

      if (rows.length === 0) {
        return json(200, genericOk, hdrs, skipCors);
      }

      const userId = rows[0].id;
      const raw = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
      const expires = new Date(Date.now() + 60 * 60 * 1000);

      await withDbRetry("auth.forgotPassword.deleteOld", () =>
        pool.query("DELETE FROM password_reset_tokens WHERE user_id = ?", [userId]),
      );
      await withDbRetry("auth.forgotPassword.insertToken", () =>
        pool.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
          [userId, tokenHash, expires],
        ),
      );

      const out = { ...genericOk };
      if (process.env.AUTH_DEBUG_TOKEN === "true") {
        out.debug_reset_token = raw;
        out.hint =
          "本番では SES 等でメール送信し URL に token を載せます。AUTH_DEBUG_TOKEN=true のときのみ token を返します。";
      }
      return json(200, out, hdrs, skipCors);
    }

    if (key === "POST /auth/reset-password") {
      const b = JSON.parse(req.body || "{}");
      if (bodyContainsSubscriptionMutationFields(b)) {
        return json(
          400,
          {
            error: "InvalidRequest",
            detail: "サブスクリプション状態は管理者のみが変更できます",
          },
          hdrs,
          skipCors,
        );
      }
      const token = String(b.token || "").trim();
      const password = String(b.password || "");
      if (!token) {
        return json(400, { error: "再設定トークンが必要です" }, hdrs, skipCors);
      }
      if (!password || !validatePassword(password)) {
        return json(
          400,
          {
            error:
              "パスワードは英数字記号8文字以上としてください。英字・数字・記号をそれぞれ1文字以上含めてください",
          },
          hdrs,
          skipCors,
        );
      }

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const [trows] = await pool.query(
        `SELECT user_id FROM password_reset_tokens
         WHERE token_hash = ? AND expires_at > NOW() LIMIT 1`,
        [tokenHash],
      );
      if (trows.length === 0) {
        return json(400, { error: "トークンが無効または期限切れです" }, hdrs, skipCors);
      }

      const userId = trows[0].user_id;
      const ph = await hashPassword(password);
      await withDbRetry("auth.resetPassword.updateUser", () =>
        pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [ph, userId]),
      );
      await withDbRetry("auth.resetPassword.deleteToken", () =>
        pool.query("DELETE FROM password_reset_tokens WHERE user_id = ?", [userId]),
      );

      return json(200, { ok: true, message: "パスワードを更新しました" }, hdrs, skipCors);
    }

    if (key === "GET /auth/me") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const { rows } = await queryMeUserRow(pool, uid);
      if (rows.length === 0) {
        return json(404, { error: "ユーザーが見つかりません" }, hdrs, skipCors);
      }
      const familyId = await resolveFamilyIdWithChatFallback(pool, uid);
      const row = rows[0] || {};
      const famSub = await getPreferredFamilySubscriptionRow(pool, uid);
      const mergedRow = mergeAuthMeSubscriptionWithPreferredFamily(row, famSub);
      const {
        is_admin: isAdminRaw,
        subscription_status: _sub,
        is_premium: _prem,
        subscription_period_end_at: _pe,
        subscription_cancel_at_period_end: _ce,
        stripe_subscription_id: _ssid,
        family_role: _familyRoleSnake,
        kid_theme: _kidThemeSnake,
        ...safeUser
      } = mergedRow;
      const familyRole = await fetchUserFamilyRoleUpperForMe(pool, uid);
      const kidTheme = await fetchUserKidTheme(pool, uid);
      const isPremium = userHasPremiumSubscriptionAccess(mergedRow, uid);
      return json(
        200,
        {
          user: {
            ...safeUser,
            isAdmin: Number(isAdminRaw) === 1,
            familyId,
            familyRole,
            kidTheme,
            isChild: Number(mergedRow.is_child) === 1,
            parentId:
              mergedRow.parent_id != null && Number.isFinite(Number(mergedRow.parent_id))
                ? Number(mergedRow.parent_id)
                : null,
            gradeGroup: normalizeGradeGroup(mergedRow.grade_group),
            subscriptionStatus: getEffectiveSubscriptionStatus(
              deriveSubscriptionStatusFromDbRow(mergedRow),
              mergedRow.id,
            ),
            ...buildUserSubscriptionApiFields(mergedRow),
            isPremium,
          },
        },
        hdrs,
        skipCors,
      );
    }

    if (key === "PATCH /auth/me/kid-theme") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const nextTheme = normalizeKidThemeInput(b.kidTheme ?? b.kid_theme);
      if (!nextTheme) {
        return json(
          400,
          {
            error:
              "kidTheme は pink / lavender / pastel_yellow / mint_green / floral / blue / navy / dino_green / space_black / sky_red のいずれかで指定してください",
          },
          hdrs,
          skipCors,
        );
      }
      const role = await fetchUserFamilyRoleUpperForMe(pool, uid);
      if (role !== "KID") {
        return json(403, { error: "子どもアカウントのみ変更できます" }, hdrs, skipCors);
      }
      try {
        const [upd] = await pool.query(
          `UPDATE users SET kid_theme = ?, updated_at = NOW() WHERE id = ? LIMIT 1`,
          [nextTheme, uid],
        );
        if (!upd?.affectedRows) {
          return json(404, { error: "ユーザーが見つかりません" }, hdrs, skipCors);
        }
      } catch (e) {
        if (isErBadFieldError(e) && String(e?.message || "").includes("kid_theme")) {
          return json(
            503,
            {
              error: "KidThemeColumnMissing",
              detail:
                "users.kid_theme 列がありません。RDS に db/migration_v20_users_kid_theme.sql を適用してください。",
            },
            hdrs,
            skipCors,
          );
        }
        throw e;
      }
      return json(200, { ok: true, kidTheme: nextTheme }, hdrs, skipCors);
    }

    if (key === "GET /families/members") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const fid = await resolveFamilyIdWithChatFallback(pool, uid);
      if (!fid) {
        return json(200, { items: [] }, hdrs, skipCors);
      }
      const [members] = await pool.query(
        `SELECT u.id, u.email, u.display_name, fm.role,
                COALESCE(u.family_role, 'MEMBER') AS family_role,
                u.kid_theme AS kid_theme
         FROM family_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.family_id = ?
         ORDER BY fm.id`,
        [fid],
      );
      return json(200, { familyId: fid, items: members }, hdrs, skipCors);
    }

    if (key === "GET /families/children") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const viewerRole = await fetchUserFamilyRoleUpperForMe(pool, uid);
      if (viewerRole === "KID") {
        return json(403, { error: "この操作はできません" }, hdrs, skipCors);
      }
      const rows = await queryChildProfilesByParent(pool, uid);
      return json(200, { items: rows }, hdrs, skipCors);
    }

    if (key === "POST /families/children") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const viewerRole = await fetchUserFamilyRoleUpperForMe(pool, uid);
      if (viewerRole === "KID") {
        return json(403, { error: "この操作はできません" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const displayNameRaw = String(b.display_name ?? b.name ?? "").trim();
      const gradeGroup = normalizeGradeGroup(b.grade_group);
      if (displayNameRaw.length < 1 || displayNameRaw.length > 100) {
        return json(400, { error: "名前は1〜100文字で入力してください" }, hdrs, skipCors);
      }
      if (!gradeGroup) {
        return json(400, { error: "学年グループは 1-2 / 3-4 / 5-6 を指定してください" }, hdrs, skipCors);
      }
      const parentFamilyId = await getDefaultFamilyId(pool, uid);
      if (!parentFamilyId) {
        return json(400, { error: "親ユーザーの家族設定が見つかりません" }, hdrs, skipCors);
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        let ins;
        try {
          [ins] = await conn.query(
            `INSERT INTO users (email, login_name, password_hash, display_name, default_family_id, family_role, is_child, parent_id, grade_group, is_admin)
             VALUES (NULL, NULL, NULL, ?, ?, 'KID', 1, ?, ?, 0)`,
            [displayNameRaw, parentFamilyId, uid, gradeGroup],
          );
        } catch (e) {
          if (isErBadFieldError(e)) {
            await conn.rollback();
            return json(
              400,
              {
                error:
                  "子供プロフィール作成に必要な users.is_child / users.parent_id / users.grade_group 列が不足しています。db/migration_v23_child_profiles.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          throw e;
        }
        const childUserId = Number(ins.insertId);
        await conn.query(
          `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'member')`,
          [parentFamilyId, childUserId],
        );
        await conn.commit();
        await seedDefaultCategoriesIfEmpty(pool, childUserId, parentFamilyId);
        return json(
          201,
          {
            id: childUserId,
            display_name: displayNameRaw,
            grade_group: gradeGroup,
            parent_id: uid,
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    if (isChildOneRoute && childOneMatch) {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const viewerRole = await fetchUserFamilyRoleUpperForMe(pool, uid);
      if (viewerRole === "KID") {
        return json(403, { error: "この操作はできません" }, hdrs, skipCors);
      }
      const targetChildId = Number(childOneMatch[1]);
      if (!Number.isFinite(targetChildId) || targetChildId <= 0) {
        return json(400, { error: "child id が不正です" }, hdrs, skipCors);
      }
      const [rows] = await pool.query(
        `SELECT id, parent_id, COALESCE(is_child, 0) AS is_child
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [targetChildId],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        return json(404, { error: "子供プロフィールが見つかりません" }, hdrs, skipCors);
      }
      const target = rows[0];
      if (Number(target.parent_id) !== uid || Number(target.is_child) !== 1) {
        return json(403, { error: "この子供プロフィールを操作する権限がありません" }, hdrs, skipCors);
      }

      if (method === "PATCH") {
        const b = JSON.parse(req.body || "{}");
        const displayNameRaw = String(b.display_name ?? b.name ?? "").trim();
        const gradeGroup = normalizeGradeGroup(b.grade_group);
        if (displayNameRaw.length < 1 || displayNameRaw.length > 100) {
          return json(400, { error: "名前は1〜100文字で入力してください" }, hdrs, skipCors);
        }
        if (!gradeGroup) {
          return json(400, { error: "学年グループは 1-2 / 3-4 / 5-6 を指定してください" }, hdrs, skipCors);
        }
        await pool.query(
          `UPDATE users
           SET display_name = ?, grade_group = ?, updated_at = NOW()
           WHERE id = ?`,
          [displayNameRaw, gradeGroup, targetChildId],
        );
        return json(
          200,
          { ok: true, id: targetChildId, display_name: displayNameRaw, grade_group: gradeGroup },
          hdrs,
          skipCors,
        );
      }

      if (method === "DELETE") {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(`DELETE FROM family_members WHERE user_id = ?`, [targetChildId]);
          await conn.query(`DELETE FROM users WHERE id = ?`, [targetChildId]);
          await conn.commit();
          return json(200, { ok: true, id: targetChildId }, hdrs, skipCors);
        } catch (e) {
          await conn.rollback();
          throw e;
        } finally {
          conn.release();
        }
      }
    }

    if (key === "GET /families/children/search") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const viewerRole = await fetchUserFamilyRoleUpperForMe(pool, uid);
      if (viewerRole === "KID") {
        return json(403, { error: "この操作はできません" }, hdrs, skipCors);
      }
      const qEmail = String(req.queryStringParameters?.email ?? "")
        .trim()
        .toLowerCase();
      if (!qEmail || !qEmail.includes("@")) {
        return json(400, { error: "検索するメールアドレスが不正です" }, hdrs, skipCors);
      }
      const rows = await queryUserByEmailForChildSearch(pool, qEmail);
      if (!Array.isArray(rows) || rows.length === 0) {
        return json(200, { found: false }, hdrs, skipCors);
      }
      const r = rows[0];
      return json(
        200,
        {
          found: true,
          user: {
            id: Number(r.id),
            email: String(r.email ?? ""),
            display_name: r.display_name == null ? null : String(r.display_name),
            is_child: Number(r.is_child) === 1,
            parent_id:
              r.parent_id != null && Number.isFinite(Number(r.parent_id))
                ? Number(r.parent_id)
                : null,
            grade_group: normalizeGradeGroup(r.grade_group),
          },
        },
        hdrs,
        skipCors,
      );
    }

    if (key === "POST /families/children/link-existing") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const viewerRole = await fetchUserFamilyRoleUpperForMe(pool, uid);
      if (viewerRole === "KID") {
        return json(403, { error: "この操作はできません" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const targetEmail = String(b.email ?? "").trim().toLowerCase();
      const gradeGroup = normalizeGradeGroup(b.grade_group);
      if (!targetEmail || !targetEmail.includes("@")) {
        return json(400, { error: "紐付けるメールアドレスが不正です" }, hdrs, skipCors);
      }
      const parentFamilyId = await getDefaultFamilyId(pool, uid);
      if (!parentFamilyId) {
        return json(400, { error: "親ユーザーの家族設定が見つかりません" }, hdrs, skipCors);
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [targetRows] = await conn.query(
          `SELECT id, email, default_family_id
           FROM users
           WHERE LOWER(email) = ?
           LIMIT 1`,
          [targetEmail],
        );
        if (!Array.isArray(targetRows) || targetRows.length === 0) {
          await conn.rollback();
          return json(404, { error: "該当ユーザーが見つかりません" }, hdrs, skipCors);
        }
        const target = targetRows[0];
        const targetUserId = Number(target.id);
        if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
          await conn.rollback();
          return json(400, { error: "対象ユーザーが不正です" }, hdrs, skipCors);
        }
        if (targetUserId === uid) {
          await conn.rollback();
          return json(400, { error: "自分自身は紐付けできません" }, hdrs, skipCors);
        }

        try {
          await conn.query(
            `UPDATE users
             SET parent_id = ?, is_child = 1, family_role = 'KID', default_family_id = ?, grade_group = COALESCE(?, grade_group), updated_at = NOW()
             WHERE id = ?`,
            [uid, parentFamilyId, gradeGroup, targetUserId],
          );
        } catch (e) {
          if (isErBadFieldError(e)) {
            await conn.rollback();
            return json(
              400,
              {
                error:
                  "子供プロフィール移行に必要な users.is_child / users.parent_id / users.grade_group 列が不足しています。db/migration_v23_child_profiles.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          throw e;
        }

        await conn.query(`DELETE FROM family_members WHERE user_id = ?`, [targetUserId]);
        await conn.query(
          `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'member')`,
          [parentFamilyId, targetUserId],
        );

        // 既存の取引履歴は user_id を維持したまま family_id を親の家族に寄せる。
        await conn.query(`UPDATE transactions SET family_id = ? WHERE user_id = ?`, [
          parentFamilyId,
          targetUserId,
        ]);

        await conn.commit();
        return json(
          200,
          {
            ok: true,
            linked_user_id: targetUserId,
            email: String(target.email ?? targetEmail),
            parent_id: uid,
            family_id: parentFamilyId,
            grade_group: gradeGroup,
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    if (key === "POST /auth/child-session") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const viewerRole = await fetchUserFamilyRoleUpperForMe(pool, uid);
      if (viewerRole === "KID") {
        return json(403, { error: "この操作はできません" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const childId = Number(b.child_id ?? b.childId);
      if (!Number.isFinite(childId) || childId <= 0) {
        return json(400, { error: "child_id が不正です" }, hdrs, skipCors);
      }
      const [rows] = await pool.query(
        `SELECT u.id, u.email, u.display_name, u.default_family_id, u.is_admin,
                COALESCE(u.family_role, 'MEMBER') AS family_role,
                COALESCE(u.is_child, 0) AS is_child, u.parent_id, u.grade_group, u.kid_theme
         FROM users u
         WHERE u.id = ? AND u.parent_id = ? AND COALESCE(u.is_child, 0) = 1
         LIMIT 1`,
        [childId, uid],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        return json(404, { error: "子供プロフィールが見つかりません" }, hdrs, skipCors);
      }
      const child = rows[0];
      const token = signUserToken(
        child.id,
        child.email == null || String(child.email).trim() === ""
          ? `child-${child.id}@local.invalid`
          : String(child.email),
      );
      return json(
        200,
        {
          token,
          user: {
            id: child.id,
            email: child.email ?? "",
            familyId: child.default_family_id ?? null,
            familyRole: "KID",
            kidTheme: normalizeKidThemeInput(child.kid_theme) ?? "blue",
            isChild: true,
            parentId: Number(child.parent_id),
            gradeGroup: normalizeGradeGroup(child.grade_group),
            isAdmin: false,
            subscriptionStatus: "inactive",
            isPremium: false,
          },
        },
        hdrs,
        skipCors,
      );
    }

    if (key === "POST /families/invite") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      if (bodyContainsSubscriptionMutationFields(b)) {
        return json(
          400,
          {
            error: "InvalidRequest",
            detail: "サブスクリプション状態は管理者のみが変更できます",
          },
          hdrs,
          skipCors,
        );
      }
      const inviteEmail = String(b.email || "")
        .trim()
        .toLowerCase();
      if (!inviteEmail?.includes("@")) {
        return json(400, { error: "メールアドレスが不正です" }, hdrs, skipCors);
      }

      const fid = await getDefaultFamilyId(pool, uid);
      if (!fid) {
        return json(400, { error: "家族が未設定です" }, hdrs, skipCors);
      }

      const [check] = await pool.query(
        `SELECT fm.user_id FROM family_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.family_id = ? AND u.email = ?`,
        [fid, inviteEmail],
      );
      if (check.length > 0) {
        return json(409, { error: "既に家族のメンバーです" }, hdrs, skipCors);
      }

      const raw = crypto.randomBytes(24).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await withDbRetry("auth.invite.insert", () =>
        pool.query(
          `INSERT INTO family_invites (family_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
          [fid, inviteEmail, tokenHash, expires],
        ),
      );

      const appOrigin = (process.env.APP_ORIGIN || "https://ksystemapp.com").replace(/\/$/, "");
      const inviteUrl = `${appOrigin}/kakeibo/register?invite=${encodeURIComponent(raw)}`;
      const lineLinkShare = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(inviteUrl)}`;
      const lineMessage = [
        "【家計簿 Kakeibo】家族への招待です。",
        `登録時はこのメールアドレスを使ってください: ${inviteEmail}`,
        inviteUrl,
      ].join("\n");
      const lineMessageShare = `https://line.me/R/msg/text/?${encodeURIComponent(lineMessage)}`;
      const res = {
        ok: true,
        message: "招待リンクを作成しました。メール・QR・LINEで共有できます。",
        invite_url: inviteUrl,
        line_share_url: lineLinkShare,
        line_message_share_url: lineMessageShare,
      };
      if (process.env.AUTH_DEBUG_TOKEN === "true") res.debug_invite_token = raw;
      return json(201, res, hdrs, skipCors);
    }

    return null;
  } catch (e) {
    logError("auth.route", e, { method, path });
    if (isRetryableDbError(e)) {
      return ctx.json(
        503,
        {
          error: "DatabaseUnavailable",
          message: "一時的にデータベースへ接続できません。少し待って再試行してください。",
          code: e?.code,
        },
        hdrs,
        skipCors,
      );
    }
    return ctx.json(
      500,
      {
        error: "InternalError",
        message:
          process.env.NODE_ENV === "development" ? String(e.message) : undefined,
      },
      hdrs,
      skipCors,
    );
  }
}
