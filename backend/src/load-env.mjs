/**
 * index.js / local-server.mjs では `import "dotenv/config"` をより先に実行してから本モジュールを読む。
 * ここでは backend/.env とリポジトリ直下 .env を明示パスで読み、cwd に依存しない。
 */
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });
dotenv.config({ path: join(__dirname, "..", "..", ".env") });

if (String(process.env.STRIPE_LOG_PRICE_ID_ON_BOOT ?? "").trim() === "1") {
  console.log(
    "[load-env] STRIPE_LOG_PRICE_ID_ON_BOOT=1 — STRIPE_TEST_PRICE_ID / STRIPE_PRICE_ID:",
    process.env.STRIPE_TEST_PRICE_ID ?? "",
    process.env.STRIPE_PRICE_ID ?? "",
  );
}
