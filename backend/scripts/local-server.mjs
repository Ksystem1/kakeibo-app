/**
 * ローカル / App Runner 用 HTTP サーバー（Express + cors）。
 *
 * 起動: cd backend && npm run dev:api  （または npm start）
 * 既定ポート: API_PORT / PORT / 3456
 *
 * dotenv: プロジェクトルートから `npm run dev` しても backend/.env を読む（cwd に依存しない）。
 */
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });
dotenv.config({ path: join(__dirname, "..", "..", ".env") });
import cors from "cors";
import express from "express";
import { expressCorsOptions } from "../src/cors-config.mjs";
import { handleApiRequest } from "../src/app-core.mjs";
import { createLogger } from "../src/logger.mjs";

const port = Number(process.env.API_PORT || process.env.PORT || "3456");
const app = express();
const logger = createLogger("local-server");

app.use(cors(expressCorsOptions()));

/** Stripe 署名検証には JSON パース前の生バイト列が必要 */
function mountStripeWebhook(expressApp, routePath) {
  expressApp.post(
    routePath,
    express.raw({ type: "application/json" }),
    async (req, res) => {
      try {
        const out = await handleApiRequest(
          {
            method: "POST",
            path: routePath,
            body: null,
            stripeRawPayload: req.body,
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
      } catch (e) {
        logger.error("stripe.webhook.route", e, { path: routePath });
        res.status(500).json({ error: "InternalError" });
      }
    },
  );
}

mountStripeWebhook(app, "/webhooks/stripe");
mountStripeWebhook(app, "/api/webhooks/stripe");

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
