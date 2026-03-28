import mysql from "mysql2/promise";

let pool;

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
      ssl: process.env.RDS_SSL === "true" ? {} : undefined,
    });
  }
  return pool;
}
