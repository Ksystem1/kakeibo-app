/**
 * ローカル / ECS 用 HTTP サーバー（Express + cors）。
 *
 * 起動: cd backend && npm run dev:api  （または npm start / node src/index.js）
 * 既定ポート: API_PORT / PORT / 3456
 *
 * app-core は巨大なため dynamic import し、CloudWatch で起動段階（モジュール読込前後）を追えるようにする。
 */
import "dotenv/config";
import "../src/load-env.mjs";
import cors from "cors";
import express from "express";
import multer from "multer";
import { expressCorsOptions } from "../src/cors-config.mjs";
import { createLogger } from "../src/logger.mjs";

function logBootLine(payload) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    event: "boot",
    ...payload,
  });
  console.log(line);
}

function summarizeRdsEnvForBoot() {
  const host = String(process.env.RDS_HOST ?? "").trim();
  const db = String(process.env.RDS_DATABASE ?? "").trim();
  const u = String(process.env.RDS_USER ?? "").trim();
  const p = String(process.env.RDS_PASSWORD ?? "").trim();
  const jsonUser = u.startsWith("{") && u.endsWith("}");
  const jsonPass = p.startsWith("{") && p.endsWith("}");
  return {
    hasRdsHost: Boolean(host),
    hasRdsDatabase: Boolean(db),
    hasRdsUserPlain: Boolean(u && !jsonUser),
    hasRdsPasswordPlain: Boolean(p && !jsonPass),
    rdsUserLooksJsonSecret: jsonUser,
    rdsPasswordLooksJsonSecret: jsonPass,
    hasRdsSecretJsonEnv: Boolean(String(process.env.RDS_SECRET_JSON ?? "").trim()),
  };
}

const port = Number(process.env.API_PORT || process.env.PORT || "3456");
const app = express();
const logger = createLogger("local-server");

process.on("uncaughtException", (err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "process.uncaught_exception",
      error: { name: err?.name, message: err?.message, stack: err?.stack },
    }),
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg =
    reason instanceof Error
      ? { name: reason.name, message: reason.message, stack: reason.stack }
      : { message: String(reason) };
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "process.unhandled_rejection",
      error: msg,
    }),
  );
});

logBootLine({
  step: "pre_app_core",
  port,
  nodeEnv: process.env.NODE_ENV ?? "",
  pid: process.pid,
  ...summarizeRdsEnvForBoot(),
  hasJwtSecret: Boolean(String(process.env.JWT_SECRET ?? "").trim()),
});

let handleApiRequest;
try {
  ({ handleApiRequest } = await import("../src/app-core.mjs"));
} catch (e) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "boot.app_core_import_failed",
      error: {
        name: e?.name,
        message: e?.message,
        stack: e?.stack,
        code: e?.code,
      },
    }),
  );
  throw e;
}

logBootLine({ step: "post_app_core" });

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
/** Stripe ダッシュボードで誤登録されやすいパス（dashboard の …/api/stripe/webhook と同等） */
mountStripeWebhook(app, "/api/stripe/webhook");
/** stripApiPathPrefix で `/api` を剥がした後のパス（環境変数 API_PATH_PREFIX=/api と …/api/stripe/webhook の組み合わせ） */
mountStripeWebhook(app, "/stripe/webhook");
/** 同一ドメインで `/kakeibo` 配下に API をプロキシしているとき（署名検証のため JSON より前に raw で取る） */
mountStripeWebhook(app, "/kakeibo/webhooks/stripe");
mountStripeWebhook(app, "/kakeibo/api/webhooks/stripe");
mountStripeWebhook(app, "/kakeibo/api/stripe/webhook");
mountStripeWebhook(app, "/kakeibo/stripe/webhook");

app.use(express.json({ limit: "15mb" }));

/** App Runner 等で req.path が期待とずれるとき originalUrl で復元 */
function pathnameOnly(req) {
  const u = req.originalUrl ?? req.url ?? "/";
  const q = u.indexOf("?");
  let pathPart = (q >= 0 ? u.slice(0, q) : u) || "/";
  if (!pathPart.startsWith("/")) pathPart = `/${pathPart}`;
  return pathPart;
}

const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

function sendApiResponse(res, out) {
  if (out.headers) {
    for (const [k, v] of Object.entries(out.headers)) {
      if (v !== undefined) res.setHeader(k, String(v));
    }
  }
  res.status(out.statusCode).send(out.body ?? "");
}

const receiptUploadPaths = ["/receipts/upload", "/api/receipts/upload"];
for (const routePath of receiptUploadPaths) {
  /* multipart: JSON の POST とは別ルートにし、非 multipart では next("route") */
  app.post(
    routePath,
    (req, res, next) => {
      const ct = String(req.headers["content-type"] || "");
      if (!ct.toLowerCase().includes("multipart/form-data")) {
        return next("route");
      }
      return uploadReceipt.single("image")(req, res, (err) => {
        if (err) {
          logger.error("receipts.upload.multer", err, { path: routePath });
          return res
            .status(400)
            .json({ error: "InvalidRequest", detail: "リクエスト本文（multipart）の解釈に失敗しました。" });
        }
        if (!req.file || !req.file.buffer) {
          return res
            .status(400)
            .json({ error: "InvalidRequest", detail: "image ファイルが必要です。" });
        }
        return next();
      });
    },
    (req, res) => {
      (async () => {
        const f = req.file;
        if (!f?.buffer) {
          return res
            .status(400)
            .json({ error: "InvalidRequest", detail: "image ファイルが必要です。" });
        }
        const out = await handleApiRequest(
          {
            method: "POST",
            path: pathnameOnly(req),
            body: null,
            headers: req.headers,
            uploadReceipt: {
              buffer: f.buffer,
              mimetype: f.mimetype,
              originalname: f.originalname,
              debugForceReceiptTier:
                req.body && req.body.debugForceReceiptTier != null
                  ? String(req.body.debugForceReceiptTier)
                  : undefined,
            },
          },
          { skipCors: true },
        );
        sendApiResponse(res, out);
      })().catch((e) => {
        logger.error("receipts.upload.multipart", e, { path: routePath });
        res.status(500).json({ error: "InternalError" });
      });
    },
  );
  app.post(routePath, (req, res) => {
    void dispatch(req, res).catch((e) => {
      logger.error("receipts.upload.json", e, { path: routePath });
      res.status(500).json({ error: "InternalError" });
    });
  });
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

const server = app.listen(port, "0.0.0.0", () => {
  const co = (process.env.CORS_ORIGIN ?? "*").trim() || "*";
  logBootLine({ step: "listen_bound", bind: `0.0.0.0:${port}` });
  logger.info("started", {
    bind: `0.0.0.0:${port}`,
    corsOrigin: co,
    health: `http://localhost:${port}/health`,
  });
});

server.on("error", (e) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "boot.listen_failed",
      error: { name: e?.name, message: e?.message, code: e?.code },
    }),
  );
  process.exit(1);
});

process.on("SIGTERM", () => {
  logBootLine({
    step: "signal_sigterm",
    detail: "ECS 等から終了シグナル（デプロイ停止・タスク置換で正常に起きうる）",
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 12_000).unref();
});
