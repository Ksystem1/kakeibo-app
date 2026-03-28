/**
 * ローカル開発用 API サーバー（Lambda 相当のルートを HTTP で提供）。
 *
 * 起動: cd backend && npm run dev:api
 * 既定: http://localhost:3456  （.env の API_PORT で変更可）
 */
import "dotenv/config";
import http from "node:http";
import { handleApiRequest } from "../src/app-core.mjs";

const port = Number(process.env.API_PORT || process.env.PORT || "3456");
const cors = process.env.CORS_ORIGIN || "http://localhost:5173";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    const out = await handleApiRequest({
      method: "OPTIONS",
      path: url.pathname,
      headers: req.headers,
    });
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body || "");
    return;
  }

  let body = "";
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "BadRequest", message: String(e.message) }));
      return;
    }
  }

  const queryStringParameters = {};
  url.searchParams.forEach((v, k) => {
    queryStringParameters[k] = v;
  });

  const out = await handleApiRequest({
    method,
    path: url.pathname,
    queryStringParameters:
      Object.keys(queryStringParameters).length > 0
        ? queryStringParameters
        : undefined,
    body: body || null,
    headers: req.headers,
  });

  res.writeHead(out.statusCode, out.headers);
  res.end(out.body ?? "");
});

server.listen(port, () => {
  console.log(`Kakeibo API (local)  http://localhost:${port}`);
  console.log(`CORS allow origin     ${cors}`);
  console.log(`Health                GET http://localhost:${port}/health`);
});
