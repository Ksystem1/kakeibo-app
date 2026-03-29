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

/** CLI スクリプト用（run-schema / ensure-dev-user など） */
export function getMysqlSslConfig() {
  return resolveSsl();
}

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.RDS_HOST,
      port: Number(process.env.RDS_PORT || "3306"),
      user: process.env.RDS_USER,
      password: process.env.RDS_PASSWORD,
      database: process.env.RDS_DATABASE,
      waitForConnections: true,
      connectionLimit: Number(process.env.RDS_CONNECTION_LIMIT || "2"),
      maxIdle: Number(process.env.RDS_MAX_IDLE || "2"),
      idleTimeout: 60000,
      enableKeepAlive: true,
      ssl: resolveSsl(),
    });
  }
  return pool;
}
