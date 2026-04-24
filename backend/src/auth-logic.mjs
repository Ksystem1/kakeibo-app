import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/**
 * 新規登録・パスワード再設定・管理者による新規ユーザー初期パスワード設定時のみ使用。
 * ログイン時は検証しない（verifyPassword のみ）。
 *
 * 8〜128 文字、印字可能 ASCII のみ、英字・数字・記号（英数字以外）をそれぞれ1文字以上。
 */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

/** @deprecated 互換のため残す。validatePassword を使用してください。 */
export const PASSWORD_REGEX = PRINTABLE_ASCII;

export function validatePassword(pw) {
  if (typeof pw !== "string") return false;
  if (pw.length < 8 || pw.length > 128) return false;
  if (!PRINTABLE_ASCII.test(pw)) return false;
  if (!/[a-zA-Z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  if (!/[^A-Za-z0-9]/.test(pw)) return false;
  return true;
}

export function normalizeHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return out;
}

export function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") return null;
  return "dev-insecure-kakeibo-change-me";
}

export function resolveUserId(headers) {
  const h = normalizeHeaders(headers);
  const xuid = h["x-user-id"];
  if (xuid && process.env.ALLOW_X_USER_ID === "true") {
    const n = Number(xuid);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const auth = h.authorization || h.Authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    const secret = getJwtSecret();
    if (!secret) return null;
    try {
      const payload = jwt.verify(token, secret);
      const uid = payload.sub ?? payload.userId;
      const n = Number(uid);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function signUserToken(userId, email) {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT_SECRET is not set（本番では必須）");
  return jwt.sign(
    { sub: String(userId), email },
    secret,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
  );
}

/**
 * メール未登録系ユーザーに NOT NULL 用の bcrypt を入れるときの共通平文（ログイン用ではない）
 * run-migration-v29.mjs およびパスキー新規（レガシー互換）と同じ値を使うこと。
 */
export const USERS_NO_PASSWORD_PLACEHOLDER = "KAKEIBO_V29_MIGRATION_PLACEHOLDER_NO_PASSWORD_LOGIN_2026_!#";

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}
