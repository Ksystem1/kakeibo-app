import mysql from "mysql2/promise";

let pool;

function parseSecretJson(raw, sourceName) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (!(text.startsWith("{") && text.endsWith("}"))) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch (e) {
    const err = new Error(`${sourceName} の JSON 解析に失敗しました`);
    err.code = "DATABASE_SECRET_JSON_INVALID";
    err.detail = e instanceof Error ? e.message : String(e);
    throw err;
  }
}

function resolveDbCredentials() {
  const secretFromDedicated = parseSecretJson(process.env.RDS_SECRET_JSON, "RDS_SECRET_JSON");
  const secretFromUserEnv = parseSecretJson(process.env.RDS_USER, "RDS_USER");
  const secretFromPasswordEnv = parseSecretJson(process.env.RDS_PASSWORD, "RDS_PASSWORD");
  const secret = secretFromDedicated || secretFromUserEnv || secretFromPasswordEnv || {};

  const userExplicit = String(process.env.RDS_USER || "").trim();
  const passExplicit = String(process.env.RDS_PASSWORD || "").trim();
  const username =
    userExplicit && !(userExplicit.startsWith("{") && userExplicit.endsWith("}"))
      ? userExplicit
      : String(secret.username ?? secret.user ?? "").trim();
  const password =
    passExplicit && !(passExplicit.startsWith("{") && passExplicit.endsWith("}"))
      ? passExplicit
      : String(secret.password ?? "").trim();

  if (!username || !password) {
    const err = new Error(
      "DB認証情報が空です。Secrets Manager の JSON に username/password が必要です。",
    );
    err.code = "DATABASE_CREDENTIALS_INVALID";
    err.detail = {
      hasSecretJson: Boolean(secretFromDedicated),
      hasUsername: Boolean(username),
      hasPassword: Boolean(password),
    };
    throw err;
  }
  return { username, password };
}

/**
 * RDS MySQL は TLS 必須のことが多い。RDS_SSL で明示できる。
 * - RDS_SSL=true  → TLS 有効（CA 検証は緩め。本番で厳格化する場合は CA ファイルを渡す）
 * - RDS_SSL=false → ローカル MySQL 等
 * - 未設定        → ホスト名が *.rds.amazonaws.com なら TLS を有効化
 */
function resolveSsl() {
  const flag = (process.env.RDS_SSL || "").toLowerCase();
  if (flag === "false" || flag === "0") {
    return undefined;
  }
  if (flag === "true" || flag === "1") {
    return { rejectUnauthorized: false };
  }
  const host = process.env.RDS_HOST || "";
  if (host.includes(".rds.amazonaws.com")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function baseConnectionOptions() {
  const host = String(process.env.RDS_HOST || "").trim();
  const creds = resolveDbCredentials();
  return {
    host,
    port: Number(process.env.RDS_PORT || "3306"),
    user: creds.username,
    password: creds.password,
    database: process.env.RDS_DATABASE,
    ssl: resolveSsl(),
  };
}

/** CLI スクリプト用（run-schema / ensure-dev-user など） */
export function getMysqlSslConfig() {
  return resolveSsl();
}

/**
 * ヘルスチェック専用: プールを使わず 1 接続だけ張って閉じる。
 * App Runner 等でプール＋maxIdle/keepAlive まわりが EBUSY になる事例を避ける。
 */
export async function pingDatabase() {
  const conn = await mysql.createConnection({
    ...baseConnectionOptions(),
    connectTimeout: Number(process.env.RDS_CONNECT_TIMEOUT_MS || "10000"),
  });
  try {
    await conn.query("SELECT 1 AS ok");
  } finally {
    await conn.end();
  }
}

export function isRdsConfigured() {
  return Boolean(String(process.env.RDS_HOST || "").trim());
}

export function getPool() {
  if (!isRdsConfigured()) {
    const err = new Error(
      "データベース（RDS）が未設定です。ECS タスクに RDS_HOST・RDS_USER 等を Secrets Manager から渡してください（Terraform: app_secret_arns）。",
    );
    err.code = "DATABASE_NOT_CONFIGURED";
    throw err;
  }
  if (!pool) {
    pool = mysql.createPool({
      ...baseConnectionOptions(),
      waitForConnections: true,
      connectionLimit: Number(process.env.RDS_CONNECTION_LIMIT || "3"),
      queueLimit: 0,
      // DNS/接続揺らぎ時にコネクション再作成を減らす
      enableKeepAlive: true,
      keepAliveInitialDelay: Number(process.env.RDS_KEEPALIVE_INITIAL_DELAY_MS || "10000"),
      connectTimeout: Number(process.env.RDS_CONNECT_TIMEOUT_MS || "10000"),
    });
  }
  return pool;
}
