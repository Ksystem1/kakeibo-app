/**
 * Lambda / ローカル HTTP 共通のルーティング本体。
 */
import { getPool } from "./db.mjs";

const CORS = {
  "access-control-allow-origin": process.env.CORS_ORIGIN || "*",
  "access-control-allow-headers": "content-type,authorization,x-user-id",
  "access-control-allow-methods": "OPTIONS,GET,POST,PUT,PATCH,DELETE",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS,
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
 */
export async function handleApiRequest(req) {
  const method = req.method.toUpperCase();
  const path = req.path.split("?")[0] || "/";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: { ...CORS }, body: "" };
  }

  try {
    if (routeKey(method, path) === "GET /health") {
      const pool = getPool();
      await pool.query("SELECT 1 AS ok");
      return json(200, { ok: true });
    }

    const userId = resolveUserId(req.headers);
    if (!userId) {
      return json(401, { error: "Unauthorized", detail: "X-User-Id required" });
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
        return json(200, { items: rows });
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
        return json(201, { id: r.insertId });
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
        return json(200, { items: rows });
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
        return json(201, { id: r.insertId });
      }

      default:
        return json(404, { error: "Not Found", path, method });
    }
  } catch (e) {
    console.error(e);
    return json(500, {
      error: "InternalError",
      message:
        process.env.NODE_ENV === "development"
          ? String(e.message)
          : undefined,
    });
  }
}
