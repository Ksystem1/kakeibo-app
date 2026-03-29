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

const port = Number(process.env.API_PORT || process.env.PORT || "3456");
const app = express();

app.use(cors(expressCorsOptions()));
app.use(express.json({ limit: "1mb" }));

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
      path: req.path || "/",
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
  console.error(err);
  res.status(500).json({ error: "InternalError" });
});

app.listen(port, "0.0.0.0", () => {
  const co = (process.env.CORS_ORIGIN ?? "*").trim() || "*";
  console.log(`Kakeibo API  http://0.0.0.0:${port}`);
  console.log(`CORS_ORIGIN  ${co}`);
  console.log(`Health       GET http://localhost:${port}/health`);
});
