import crypto from "node:crypto";
import {
  hashPassword,
  resolveUserId,
  signUserToken,
  validatePassword,
  verifyPassword,
} from "./auth-logic.mjs";

function routeKey(method, path) {
  const p = path.replace(/\/$/, "") || "/";
  return `${method} ${p}`;
}

export async function getDefaultFamilyId(pool, userId) {
  const [rows] = await pool.query(
    `SELECT COALESCE(
       u.default_family_id,
       (SELECT fm.family_id FROM family_members fm WHERE fm.user_id = u.id ORDER BY fm.id LIMIT 1)
     ) AS fid
     FROM users u WHERE u.id = ?`,
    [userId],
  );
  return rows[0]?.fid ?? null;
}

/**
 * @returns {Promise<{ statusCode, headers, body }|null>}
 */
export async function tryAuthRoutes(req, ctx) {
  const { pool, json, hdrs, skipCors } = ctx;
  const method = req.method.toUpperCase();
  const path = req.path.split("?")[0] || "/";
  const key = routeKey(method, path);

  try {
    if (key === "POST /auth/register") {
      const b = JSON.parse(req.body || "{}");
      const email = String(b.email || "")
        .trim()
        .toLowerCase();
      const loginName = b.login_name
        ? String(b.login_name).trim()
        : null;
      const password = String(b.password || "");
      const displayName = b.display_name
        ? String(b.display_name).trim()
        : null;

      if (!email || !email.includes("@")) {
        return json(400, { error: "メールアドレスが不正です" }, hdrs, skipCors);
      }
      if (!validatePassword(password)) {
        return json(400, {
          error: "パスワードは英数字8文字以上にしてください",
        }, hdrs, skipCors);
      }

      const ph = await hashPassword(password);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const dupSql = loginName
          ? "SELECT id FROM users WHERE email = ? OR login_name = ?"
          : "SELECT id FROM users WHERE email = ?";
        const dupParams = loginName ? [email, loginName] : [email];
        const [dup] = await conn.query(dupSql, dupParams);
        if (dup.length > 0) {
          await conn.rollback();
          return json(409, { error: "既に登録済みのメールまたはログインIDです" }, hdrs, skipCors);
        }

        const [ur] = await conn.query(
          `INSERT INTO users (email, login_name, password_hash, display_name)
           VALUES (?, ?, ?, ?)`,
          [email, loginName || null, ph, displayName],
        );
        const userId = ur.insertId;

        const [fr] = await conn.query(
          "INSERT INTO families (name) VALUES (?)",
          [b.family_name?.trim() || "マイ家族"],
        );
        const familyId = fr.insertId;

        await conn.query("UPDATE users SET default_family_id = ? WHERE id = ?", [
          familyId,
          userId,
        ]);
        await conn.query(
          `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'owner')`,
          [familyId, userId],
        );

        await conn.commit();

        const token = signUserToken(userId, email);
        return json(
          201,
          { token, user: { id: userId, email, familyId } },
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
      const login = String(b.login || b.email || "")
        .trim()
        .toLowerCase();
      const password = String(b.password || "");
      if (!login || !password) {
        return json(400, { error: "ログインIDとパスワードを入力してください" }, hdrs, skipCors);
      }

      const [rows] = await pool.query(
        `SELECT id, email, password_hash FROM users
         WHERE LOWER(email) = ? OR (login_name IS NOT NULL AND LOWER(login_name) = ?)`,
        [login, login],
      );
      if (rows.length === 0) {
        return json(401, { error: "ログインに失敗しました" }, hdrs, skipCors);
      }
      const u = rows[0];
      const ok = await verifyPassword(password, u.password_hash);
      if (!ok) {
        return json(401, { error: "ログインに失敗しました" }, hdrs, skipCors);
      }

      const token = signUserToken(u.id, u.email);
      const familyId = await getDefaultFamilyId(pool, u.id);
      return json(
        200,
        { token, user: { id: u.id, email: u.email, familyId } },
        hdrs,
        skipCors,
      );
    }

    if (key === "POST /auth/forgot-password") {
      const b = JSON.parse(req.body || "{}");
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

      await pool.query("DELETE FROM password_reset_tokens WHERE user_id = ?", [
        userId,
      ]);
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
        [userId, tokenHash, expires],
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
      const token = String(b.token || "").trim();
      const password = String(b.password || "");
      if (!token || !validatePassword(password)) {
        return json(400, {
          error: "トークンと新パスワード（英数字8文字以上）が必要です",
        }, hdrs, skipCors);
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
      await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [
        ph,
        userId,
      ]);
      await pool.query("DELETE FROM password_reset_tokens WHERE user_id = ?", [
        userId,
      ]);

      return json(200, { ok: true, message: "パスワードを更新しました" }, hdrs, skipCors);
    }

    if (key === "GET /auth/me") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const [rows] = await pool.query(
        `SELECT id, email, login_name, display_name, default_family_id FROM users WHERE id = ?`,
        [uid],
      );
      if (rows.length === 0) {
        return json(404, { error: "ユーザーが見つかりません" }, hdrs, skipCors);
      }
      const familyId = await getDefaultFamilyId(pool, uid);
      return json(
        200,
        { user: { ...rows[0], familyId } },
        hdrs,
        skipCors,
      );
    }

    if (key === "GET /families/members") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const fid = await getDefaultFamilyId(pool, uid);
      if (!fid) {
        return json(200, { items: [] }, hdrs, skipCors);
      }
      const [members] = await pool.query(
        `SELECT u.id, u.email, u.display_name, fm.role
         FROM family_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.family_id = ?
         ORDER BY fm.id`,
        [fid],
      );
      return json(200, { familyId: fid, items: members }, hdrs, skipCors);
    }

    if (key === "POST /families/invite") {
      const uid = resolveUserId(req.headers);
      if (!uid) {
        return json(401, { error: "認証が必要です" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
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
      await pool.query(
        `INSERT INTO family_invites (family_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
        [fid, inviteEmail, tokenHash, expires],
      );

      const res = {
        ok: true,
        message: "招待を登録しました。相手がアカウント作成後に承認フローを拡張できます。",
      };
      if (process.env.AUTH_DEBUG_TOKEN === "true") {
        res.debug_invite_token = raw;
      }
      return json(201, res, hdrs, skipCors);
    }

    return null;
  } catch (e) {
    console.error("auth route", e);
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
