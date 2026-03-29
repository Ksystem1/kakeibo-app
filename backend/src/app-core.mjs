/**
 * Lambda / ローカル HTTP 共通のルーティング本体。
 */
import { buildCorsHeaders } from "./cors-config.mjs";
import { getPool, pingDatabase } from "./db.mjs";

function json(statusCode, body, reqHeaders, skipCors) {
  const cors = skipCors ? {} : buildCorsHeaders(reqHeaders);
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...cors,
    },
    body: JSON.stringify(body),
  };
}

function normalizeHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return out;
}

export function resolveUserId(headers) {
  const h = normalizeHeaders(headers);
  const raw = h["x-user-id"];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function routeKey(method, path) {
  const p = path.replace(/\/$/, "") || "/";
  return `${method} ${p}`;
}

/**
 * @param {{ method: string, path: string, queryStringParameters?: Record<string,string>|null, body?: string|null, headers?: Record<string, string> }} req
 * @param {{ skipCors?: boolean }} [options] Express で cors ミドルウェアを使うとき true（ヘッダー二重付与防止）
 */
export async function handleApiRequest(req, options = {}) {
  const { skipCors = false } = options;
  const method = req.method.toUpperCase();
  const path = req.path.split("?")[0] || "/";
  const hdrs = req.headers;

  if (method === "OPTIONS") {
    const cors = skipCors ? {} : buildCorsHeaders(hdrs);
    return { statusCode: 204, headers: { ...cors }, body: "" };
  }

  try {
    // ブラウザでドメイン直下を開いたとき用（認証・DB 不要）
    if (routeKey(method, path) === "GET /") {
      return json(
        200,
        {
          service: "kakeibo-api",
          message:
            "API は動作しています。疎通は GET /health 。取引などは X-User-Id ヘッダーが必要です。",
          endpoints: {
            health: "/health",
            categories: "/categories",
            transactions: "/transactions",
          },
        },
        hdrs,
        skipCors,
      );
    }

    if (routeKey(method, path) === "GET /health") {
      try {
        await pingDatabase();
        return json(200, { ok: true, database: "up" }, hdrs, skipCors);
      } catch (e) {
        console.error("GET /health DB:", e);
        const o = e && typeof e === "object" ? e : {};
        const code =
          o.code ??
          (o.errno != null ? `errno_${o.errno}` : "UNKNOWN");
        const sqlMessage =
          typeof o.sqlMessage === "string" ? o.sqlMessage : undefined;
        const verbose =
          process.env.NODE_ENV === "development" ||
          process.env.HEALTH_VERBOSE === "true";
        return json(
          503,
          {
            ok: false,
            error: "DatabaseUnavailable",
            code: String(code),
            ...(sqlMessage ? { sqlMessage } : {}),
            hint:
              "RDS の環境変数・VPC コネクタ・セキュリティグループ・TLS を確認してください。code が EBUSY のときはプールではなく直接接続に切り替え済みです。",
            ...(verbose && e instanceof Error ? { message: e.message } : {}),
          },
          hdrs,
          skipCors,
        );
      }
    }

    const userId = resolveUserId(hdrs);
    if (!userId) {
      return json(
        401,
        {
          error: "認証されていません",
          detail: "X-User-Id が必要です",
        },
        hdrs,
        skipCors,
      );
    }

    const pool = getPool();
    const q = req.queryStringParameters || {};

    switch (routeKey(method, path)) {
      case "GET /categories": {
        const [rows] = await pool.query(
          `SELECT id, parent_id, name, kind, color_hex, sort_order, is_archived, created_at, updated_at
           FROM categories
           WHERE user_id = ? AND is_archived = 0
           ORDER BY kind, sort_order, id`,
          [userId],
        );
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /categories": {
        const b = JSON.parse(req.body || "{}");
        const [r] = await pool.query(
          `INSERT INTO categories (user_id, parent_id, name, kind, color_hex, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            userId,
            b.parent_id ?? null,
            b.name,
            b.kind ?? "expense",
            b.color_hex ?? null,
            b.sort_order ?? 0,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      case "GET /transactions": {
        const from = q.from;
        const to = q.to;
        let sql = `SELECT id, account_id, category_id, kind, amount, transaction_date, memo, created_at, updated_at
                   FROM transactions WHERE user_id = ?`;
        const params = [userId];
        if (from) {
          sql += ` AND transaction_date >= ?`;
          params.push(from);
        }
        if (to) {
          sql += ` AND transaction_date <= ?`;
          params.push(to);
        }
        sql += ` ORDER BY transaction_date DESC, id DESC LIMIT 500`;
        const [rows] = await pool.query(sql, params);
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /transactions": {
        const b = JSON.parse(req.body || "{}");
        const [r] = await pool.query(
          `INSERT INTO transactions
           (user_id, account_id, category_id, kind, amount, transaction_date, memo, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            b.account_id ?? null,
            b.category_id ?? null,
            b.kind ?? "expense",
            b.amount,
            b.transaction_date,
            b.memo ?? null,
            b.external_id ?? null,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      default:
        return json(404, { error: "Not Found", path, method }, hdrs, skipCors);
    }
  } catch (e) {
    console.error(e);
    return json(
      500,
      {
        error: "InternalError",
        message:
          process.env.NODE_ENV === "development"
            ? String(e.message)
            : undefined,
      },
      hdrs,
      skipCors,
    );
  }
}
