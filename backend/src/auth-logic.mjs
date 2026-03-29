import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/** 英数字8文字以上（仕様①） */
export const PASSWORD_REGEX = /^[a-zA-Z0-9]{8,}$/;

export function validatePassword(pw) {
  return typeof pw === "string" && PASSWORD_REGEX.test(pw);
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

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}
