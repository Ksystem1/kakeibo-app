import crypto from "node:crypto";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";

function b64urlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function b64urlDecodeToBuffer(input) {
  return Buffer.from(String(input || ""), "base64url");
}

function hmacSign(text, secret) {
  return crypto.createHmac("sha256", secret).update(text).digest("base64url");
}

function flowSecret() {
  return String(process.env.JWT_SECRET || "dev-insecure-kakeibo-change-me");
}

export function resolvePasskeyConfig() {
  const appOrigin = String(process.env.APP_ORIGIN || "http://localhost:5173").trim();
  let hostname = "localhost";
  try {
    hostname = new URL(appOrigin).hostname || "localhost";
  } catch {
    hostname = "localhost";
  }
  const rpID = String(process.env.WEBAUTHN_RP_ID || hostname).trim() || hostname;
  const rpName = String(process.env.WEBAUTHN_RP_NAME || "Kakeibo").trim() || "Kakeibo";
  const expectedOrigins = new Set([appOrigin]);
  if (process.env.NODE_ENV !== "production") {
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
  const userID = crypto.randomBytes(24).toString("base64url");
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
    iv: String(inviteToken || ""),
  });
  return { options, flowToken };
}

export async function verifyPasskeyRegistration({ credential, expectedChallenge }) {
  const { rpID, expectedOrigins } = resolvePasskeyConfig();
  return verifyRegistrationResponse({
    response: credential,
    expectedChallenge: String(expectedChallenge || ""),
    expectedOrigin: expectedOrigins,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
}

export function registrationInfoToDbValues(verification, transports) {
  const info = verification?.registrationInfo;
  const cred = info?.credential || {};
  const idCandidate = cred.id ?? info?.credentialID ?? "";
  const pkCandidate = cred.publicKey ?? info?.credentialPublicKey ?? null;
  const counterCandidate = cred.counter ?? info?.counter ?? 0;
  const credentialIdBuf =
    Buffer.isBuffer(idCandidate)
      ? idCandidate
      : idCandidate instanceof Uint8Array
        ? Buffer.from(idCandidate)
        : b64urlDecodeToBuffer(idCandidate);
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
    credentialIdBuf,
    publicKeyBuf,
    counter,
    transportsCsv: transportList.length > 0 ? transportList.join(",") : null,
  };
}
