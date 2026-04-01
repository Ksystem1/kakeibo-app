/**
 * ローカル / App Runner 用 HTTP サーバー（Express + cors）。
 *
 * 起動: cd backend && npm run dev:api  （または npm start）
 * 既定ポート: API_PORT / PORT / 3456
 */
import "dotenv/config";
import cors from "cors";
import express from "express";
import { expressCorsOptions } from "../src/cors-config.mjs";
import { handleApiRequest } from "../src/app-core.mjs";
import { createLogger } from "../src/logger.mjs";

const port = Number(process.env.API_PORT || process.env.PORT || "3456");
const app = express();
const logger = createLogger("local-server");

app.use(cors(expressCorsOptions()));
app.use(express.json({ limit: "15mb" }));

/** App Runner 等で req.path が期待とずれるとき originalUrl で復元 */
function pathnameOnly(req) {
  const u = req.originalUrl ?? req.url ?? "/";
  const q = u.indexOf("?");
  let p = (q >= 0 ? u.slice(0, q) : u) || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

async function dispatch(req, res) {
  let body = null;
  const m = req.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    if (req.body !== undefined && req.body !== null) {
      body =
        typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body);
    }
  }

  const out = await handleApiRequest(
    {
      method: req.method,
      path: pathnameOnly(req),
      queryStringParameters:
        Object.keys(req.query ?? {}).length > 0 ? req.query : undefined,
      body,
      headers: req.headers,
    },
    { skipCors: true },
  );

  if (out.headers) {
    for (const [k, v] of Object.entries(out.headers)) {
      if (v !== undefined) res.setHeader(k, String(v));
    }
  }
  res.status(out.statusCode).send(out.body ?? "");
}

app.use((req, res, next) => {
  dispatch(req, res).catch(next);
});

app.use((err, _req, res, _next) => {
  logger.error("unhandled", err);
  res.status(500).json({ error: "InternalError" });
});

app.listen(port, "0.0.0.0", () => {
  const co = (process.env.CORS_ORIGIN ?? "*").trim() || "*";
  logger.info("started", {
    bind: `0.0.0.0:${port}`,
    corsOrigin: co,
    health: `http://localhost:${port}/health`,
  });
});
