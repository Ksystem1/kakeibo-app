import crypto from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

function b64urlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function b64urlDecodeToBuffer(input) {
  return Buffer.from(String(input || ""), "base64url");
}

function ensureB64urlId(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  return Buffer.from(s).toString("base64url");
}

function hmacSign(text, secret) {
  return crypto.createHmac("sha256", secret).update(text).digest("base64url");
}

function flowSecret() {
  return String(process.env.JWT_SECRET || "dev-insecure-kakeibo-change-me");
}

export function resolvePasskeyConfig() {
  const isProd = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const defaultOrigin = isProd
    ? "https://ksystemapp.com"
    : String(process.env.APP_ORIGIN || "http://localhost:3000");
  // 本番は WebAuthn 専用環境変数を優先し、APP_ORIGIN の誤設定で壊れないようにする
  const originRaw = String(process.env.WEBAUTHN_ORIGIN || process.env.ORIGIN || defaultOrigin).trim();
  const appOrigin = (originRaw || defaultOrigin).replace(/\/+$/, "");
  let hostname = isProd ? "ksystemapp.com" : "localhost";
  try {
    hostname = new URL(appOrigin).hostname || hostname;
  } catch {
    /* fallback hostname を使用 */
  }
  const rpID = String(
    process.env.WEBAUTHN_RP_ID || process.env.RP_ID || (isProd ? "ksystemapp.com" : "localhost"),
  ).trim() || hostname;
  const rpName = String(process.env.WEBAUTHN_RP_NAME || "Kakeibo").trim() || "Kakeibo";
  const expectedOrigins = new Set([appOrigin]);
  if (process.env.NODE_ENV !== "production") {
    expectedOrigins.add("http://localhost:3000");
    expectedOrigins.add("http://127.0.0.1:3000");
    expectedOrigins.add("http://localhost:5173");
    expectedOrigins.add("http://127.0.0.1:5173");
  }
  return { rpID, rpName, expectedOrigins: Array.from(expectedOrigins) };
}

export function issuePasskeyRegistrationFlowToken(payload, ttlSec = 600) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + Math.max(60, Number(ttlSec) || 600),
  };
  const encoded = b64urlEncode(JSON.stringify(body));
  const sig = hmacSign(encoded, flowSecret());
  return `${encoded}.${sig}`;
}

export function verifyPasskeyRegistrationFlowToken(token) {
  const raw = String(token || "");
  const idx = raw.lastIndexOf(".");
  if (idx < 1) return null;
  const encoded = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = hmacSign(encoded, flowSecret());
  if (sig !== expected) return null;
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || Number(payload.exp || 0) < now) return null;
  return payload;
}

export async function buildPasskeyRegistrationOptions({ displayName = "ユーザー", inviteToken = "" }) {
  const { rpID, rpName } = resolvePasskeyConfig();
  const challenge = crypto.randomBytes(32).toString("base64url");
  const userName = `passkey-${crypto.randomUUID()}`;
  // user.id はバイナリ（Uint8Array/Buffer）で渡す
  const userID = crypto.randomBytes(32);
  const options = await generateRegistrationOptions({
    rpID,
    rpName,
    userName,
    userDisplayName: String(displayName || "ユーザー").slice(0, 100),
    userID,
    timeout: 60_000,
    challenge,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7, -257],
  });
  const flowToken = issuePasskeyRegistrationFlowToken({
    c: challenge,
    n: String(displayName || "ユーザー").slice(0, 100),
    u: userName,
    uid: userID.toString("base64url"),
    iv: String(inviteToken || ""),
  });
  return { options, flowToken };
}

export async function buildPasskeyAuthenticationOptions() {
  const { rpID } = resolvePasskeyConfig();
  const challenge = crypto.randomBytes(32).toString("base64url");
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60_000,
    userVerification: "preferred",
    allowCredentials: [],
  });
  const flowToken = issuePasskeyRegistrationFlowToken({ c: challenge, m: "login" }, 600);
  options.challenge = challenge;
  return { options, flowToken };
}

export async function verifyPasskeyRegistration({ credential, expectedChallenge }) {
  const isProd = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const { rpID, expectedOrigins } = resolvePasskeyConfig();
  const expectedRPID = isProd ? ["ksystemapp.com", "www.ksystemapp.com"] : rpID;
  const expectedOrigin = isProd
    ? ["https://ksystemapp.com", "https://www.ksystemapp.com"]
    : expectedOrigins;
  return verifyRegistrationResponse({
    response: credential,
    expectedChallenge: String(expectedChallenge || ""),
    expectedOrigin,
    expectedRPID,
    requireUserVerification: false,
  });
}

export async function verifyPasskeyAuthentication({
  credential,
  expectedChallenge,
  authenticator,
}) {
  const isProd = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const { rpID, expectedOrigins } = resolvePasskeyConfig();
  const expectedRPID = isProd ? ["ksystemapp.com", "www.ksystemapp.com"] : rpID;
  const expectedOrigin = isProd
    ? ["https://ksystemapp.com", "https://www.ksystemapp.com"]
    : expectedOrigins;
  return verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: String(expectedChallenge || ""),
    expectedOrigin,
    expectedRPID,
    authenticator,
    requireUserVerification: false,
  });
}

export function registrationInfoToDbValues(verification, transports) {
  const info = verification?.registrationInfo;
  const cred = info?.credential || {};
  const idCandidate = cred.id ?? info?.credentialID ?? "";
  const pkCandidate = cred.publicKey ?? info?.credentialPublicKey ?? null;
  const counterCandidate = cred.counter ?? info?.counter ?? 0;
  const credentialId =
    Buffer.isBuffer(idCandidate)
      ? idCandidate.toString("base64url")
      : idCandidate instanceof Uint8Array
        ? Buffer.from(idCandidate).toString("base64url")
        : ensureB64urlId(idCandidate);
  const publicKeyBuf =
    Buffer.isBuffer(pkCandidate)
      ? pkCandidate
      : pkCandidate instanceof Uint8Array
        ? Buffer.from(pkCandidate)
        : Buffer.from([]);
  const counter = Number(counterCandidate) || 0;
  const transportList = Array.isArray(transports)
    ? transports.map((x) => String(x).trim()).filter(Boolean)
    : [];
  return {
    credentialId,
    publicKeyBuf,
    counter,
    transportsCsv: transportList.length > 0 ? transportList.join(",") : null,
  };
}

export function generateRecoveryCode() {
  const raw = crypto.randomBytes(8).toString("hex").toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function hashRecoveryCode(raw) {
  const normalized = String(raw || "").replace(/-/g, "").trim().toUpperCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
