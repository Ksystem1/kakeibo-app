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

function buildExpectedChallengeVerifier(expectedChallengeRaw) {
  const expected = String(expectedChallengeRaw || "").trim();
  const expectedDoubleEncoded = Buffer.from(expected, "utf8").toString("base64url");
  return (receivedChallenge) => {
    const received = String(receivedChallenge || "").trim();
    return received === expected || received === expectedDoubleEncoded;
  };
}

function hmacSign(text, secret) {
  return crypto.createHmac("sha256", secret).update(text).digest("base64url");
}

function flowSecret() {
  return String(process.env.JWT_SECRET || "dev-insecure-kakeibo-change-me");
}

/**
 * WebAuthn の RP / Origin は環境変数を源泉とする。コード内に localhost 文字列は置かない。
 * 開発: WEBAUTHN_ORIGIN または APP_ORIGIN（未設定時は Vite 既定 127.0.0.1:5173）
 * 本番: WEBAUTHN_ORIGIN 未設定時 https://ksystemapp.com
 * 付加: WEBAUTHN_ADDITIONAL_ORIGINS（カンマ区切り）で同じマシンからの別表記（例: .env 側で補完）
 */
export function resolvePasskeyConfig() {
  const isProd = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const primary = String(
    process.env.WEBAUTHN_ORIGIN || process.env.APP_ORIGIN || process.env.PUBLIC_APP_ORIGIN || "",
  )
    .trim()
    .replace(/\/+$/, "");
  const fallbackOrigin = isProd ? "https://ksystemapp.com" : "http://127.0.0.1:5173";
  const appOrigin = (primary || fallbackOrigin).replace(/\/+$/, "");
  let hostFromUrl = isProd ? "ksystemapp.com" : "127.0.0.1";
  try {
    hostFromUrl = new URL(appOrigin).hostname || hostFromUrl;
  } catch {
    /* 既定 hostname */
  }
  const envRp = String(process.env.WEBAUTHN_RP_ID || process.env.RP_ID || "").trim();
  const defaultRp = isProd ? "ksystemapp.com" : hostFromUrl;
  const rpID = envRp || defaultRp;
  const extraRp = String(process.env.WEBAUTHN_ADDITIONAL_RP_IDS || "");
  const rpIdSet = new Set(
    [rpID, ...extraRp.split(/[,;]/).map((s) => s.trim()).filter(Boolean)],
  );
  if (isProd) {
    rpIdSet.add("ksystemapp.com");
    rpIdSet.add("www.ksystemapp.com");
  }
  const expectedRPIDs = Array.from(rpIdSet);
  const rpName = String(process.env.WEBAUTHN_RP_NAME || "Kakeibo").trim() || "Kakeibo";
  const expectedOrigins = new Set();
  const addO = (o) => {
    const t = String(o).trim().replace(/\/+$/, "");
    if (t) expectedOrigins.add(t);
  };
  addO(appOrigin);
  for (const part of String(
    process.env.WEBAUTHN_ADDITIONAL_ORIGINS || process.env.CORS_ALLOW_ORIGIN || "",
  )
    .split(/[,;]/)) {
    addO(part);
  }
  if (isProd) {
    addO("https://ksystemapp.com");
    addO("https://www.ksystemapp.com");
  }
  return {
    rpID,
    rpName,
    appOrigin,
    expectedOrigins: Array.from(expectedOrigins),
    expectedRPIDs: expectedRPIDs.length > 0 ? expectedRPIDs : [rpID],
  };
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
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7, -257],
  });
  const challenge = String(options.challenge || "").trim() || crypto.randomBytes(32).toString("base64url");
  const flowToken = issuePasskeyRegistrationFlowToken({
    c: challenge,
    n: String(displayName || "ユーザー").slice(0, 100),
    u: userName,
    uid: userID.toString("base64url"),
    iv: String(inviteToken || ""),
  });
  // 返却 challenge と flow token の challenge を必ず一致させる
  options.challenge = challenge;
  return { options, flowToken };
}

export async function buildPasskeyAuthenticationOptions() {
  const { rpID } = resolvePasskeyConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60_000,
    userVerification: "preferred",
    allowCredentials: [],
  });
  const challenge = String(options.challenge || "").trim() || crypto.randomBytes(32).toString("base64url");
  const flowToken = issuePasskeyRegistrationFlowToken({ c: challenge, m: "login" }, 600);
  options.challenge = challenge;
  return { options, flowToken };
}

export async function verifyPasskeyRegistration({ credential, expectedChallenge }) {
  const cfg = resolvePasskeyConfig();
  return verifyRegistrationResponse({
    response: credential,
    expectedChallenge: buildExpectedChallengeVerifier(expectedChallenge),
    expectedOrigin: cfg.expectedOrigins,
    expectedRPID: cfg.expectedRPIDs,
    requireUserVerification: false,
  });
}

export async function verifyPasskeyAuthentication({
  credential,
  expectedChallenge,
  authenticator,
}) {
  const cfg = resolvePasskeyConfig();
  return verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: buildExpectedChallengeVerifier(expectedChallenge),
    expectedOrigin: cfg.expectedOrigins,
    expectedRPID: cfg.expectedRPIDs,
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
