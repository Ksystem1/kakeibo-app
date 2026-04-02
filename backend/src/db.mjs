import mysql from "mysql2/promise";

let pool;

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
  return {
    host,
    port: Number(process.env.RDS_PORT || "3306"),
    user: process.env.RDS_USER,
    password: process.env.RDS_PASSWORD,
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
