/**
 * Lambda / Express 共通ルータ
 */
import { tryAuthRoutes, getDefaultFamilyId } from "./auth-routes.mjs";
import { resolveUserId } from "./auth-logic.mjs";
import { buildCorsHeaders } from "./cors-config.mjs";
import { getPool, pingDatabase } from "./db.mjs";

function logError(event, e, extra = {}) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      code: e?.code,
      errno: e?.errno,
      syscall: e?.syscall,
      hostname: e?.hostname,
      sqlState: e?.sqlState,
      message: e?.message,
      ...extra,
    }),
  );
}

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

function routeKey(method, path) {
  const p = path.replace(/\/$/, "") || "/";
  return `${method} ${p}`;
}

function ymBounds(yearMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = `${y}-${String(mo).padStart(2, "0")}-01`;
  const last = new Date(y, mo, 0).getDate();
  const to = `${y}-${String(mo).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

/**
 * @param {{ method: string, path: string, queryStringParameters?: Record<string,string>|null, body?: string|null, headers?: Record<string, string> }} req
 * @param {{ skipCors?: boolean }} [options]
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

  const pool = getPool();

  try {
    const authRes = await tryAuthRoutes(req, {
      pool,
      json,
      hdrs,
      skipCors,
    });
    if (authRes) return authRes;

    if (routeKey(method, path) === "GET /") {
      return json(
        200,
        {
          service: "kakeibo-api",
          message:
            "API は稼働中です。認証: POST /auth/login（JWT）。ヘルス: GET /health",
          endpoints: {
            health: "/health",
            auth: "/auth/login",
            transactions: "/transactions",
            summary: "/summary/month",
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
        logError("health.db", e, { method, path });
        const o = e && typeof e === "object" ? e : {};
        const code =
          o.code ?? (o.errno != null ? `errno_${o.errno}` : "UNKNOWN");
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
              "RDS の環境変数・VPC コネクタ・セキュリティグループを確認してください。",
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
          detail: "Authorization: Bearer <JWT> が必要です（開発時のみ ALLOW_X_USER_ID=true で X-User-Id 可）",
        },
        hdrs,
        skipCors,
      );
    }

    const q = req.queryStringParameters || {};
    const familyId = await getDefaultFamilyId(pool, userId);

    const catWhere = `(c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (c.family_id IS NULL AND c.user_id = ?))`;
    const txWhere = `(t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (t.family_id IS NULL AND t.user_id = ?))`;

    switch (routeKey(method, path)) {
      case "GET /categories": {
        const [rows] = await pool.query(
          `SELECT c.id, c.parent_id, c.name, c.kind, c.color_hex, c.sort_order, c.is_archived, c.created_at, c.updated_at
           FROM categories c
           WHERE ${catWhere} AND c.is_archived = 0
           ORDER BY c.kind, c.sort_order, c.id`,
          [userId, userId],
        );
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /categories": {
        const b = JSON.parse(req.body || "{}");
        const [r] = await pool.query(
          `INSERT INTO categories (user_id, family_id, parent_id, name, kind, color_hex, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
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
        let sql = `SELECT t.id, t.account_id, t.category_id, t.kind, t.amount, t.transaction_date, t.memo, t.created_at, t.updated_at, t.user_id
                   FROM transactions t
                   WHERE ${txWhere}`;
        const params = [userId, userId];
        if (from) {
          sql += ` AND t.transaction_date >= ?`;
          params.push(from);
        }
        if (to) {
          sql += ` AND t.transaction_date <= ?`;
          params.push(to);
        }
        sql += ` ORDER BY t.transaction_date DESC, t.id DESC LIMIT 500`;
        const [rows] = await pool.query(sql, params);
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /transactions": {
        const b = JSON.parse(req.body || "{}");
        const [r] = await pool.query(
          `INSERT INTO transactions
           (user_id, family_id, account_id, category_id, kind, amount, transaction_date, memo, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
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

      case "GET /summary/month": {
        const ym = q.year_month || q.yearMonth;
        const bounds = ymBounds(ym);
        if (!bounds) {
          return json(
            400,
            { error: "year_month=YYYY-MM が必要です" },
            hdrs,
            skipCors,
          );
        }
        const { from, to } = bounds;
        const [expRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'expense'
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [userId, userId, from, to],
        );
        const [incRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'income'
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [userId, userId, from, to],
        );
        const [[sumE]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'expense'`,
          [userId, userId, from, to],
        );
        const [[sumI]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhere}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'income'`,
          [userId, userId, from, to],
        );
        return json(
          200,
          {
            year_month: ym,
            from,
            to,
            expenseTotal: sumE.total,
            incomeTotal: sumI.total,
            expensesByCategory: expRows,
            incomesByCategory: incRows,
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /import/csv": {
        const b = JSON.parse(req.body || "{}");
        const text = String(b.csvText || "");
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        let inserted = 0;
        for (const line of lines) {
          const parts = line.split(/[,，\t]/).map((s) => s.trim());
          if (parts.length < 2) continue;
          const dateStr = parts[0].replace(/\//g, "-");
          const amount = Number.parseFloat(parts[1].replace(/[,円]/g, ""));
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Number.isFinite(amount)) {
            continue;
          }
          const memo = parts.slice(2).join(" ") || "CSV取込";
          await pool.query(
            `INSERT INTO transactions (user_id, family_id, kind, amount, transaction_date, memo)
             VALUES (?, ?, 'expense', ?, ?, ?)`,
            [userId, familyId, Math.abs(amount), dateStr, memo],
          );
          inserted += 1;
        }
        return json(
          200,
          {
            ok: true,
            inserted,
            message:
              "汎用CSV（日付,金額,メモ…）を取り込みました。銀行独自形式は今後拡張予定です。",
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /receipts/parse": {
        const b = JSON.parse(req.body || "{}");
        const hasImage = Boolean(b.imageBase64);
        return json(
          200,
          {
            ok: true,
            demo: !hasImage,
            items: hasImage
              ? [
                  { name: "サンプル品目", amount: 498, confidence: 0.42 },
                  { name: "（デモ）実装は AWS Textract AnalyzeExpense 推奨", amount: null, confidence: 0 },
                ]
              : [],
            apis: {
              aws:
                "Textract AnalyzeExpense / AnalyzeID — レシート行・合計の抽出",
              google: "Document AI Expense Parser",
              openai: "Vision API で画像→JSON（プロンプト設計が必要）",
            },
            notice:
              hasImage
                ? "現在はスタブ応答です。本番では画像を Textract に送り line_items をマッピングしてください。"
                : "imageBase64 にレシート画像を送るとデモ行を返します。",
          },
          hdrs,
          skipCors,
        );
      }

      default:
        return json(404, { error: "Not Found", path, method }, hdrs, skipCors);
    }
  } catch (e) {
    logError("api.unhandled", e, { method, path });
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

export { resolveUserId };
