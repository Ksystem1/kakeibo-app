/**
 * 必ず他の application モジュールより先に import すること。
 * ESM では import が巻き上げられるため、dotenv を各ファイル内に書くだけでは
 * app-core 等が先に評価され、起動時点で .env が未反映になることがある。
 */
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });
dotenv.config({ path: join(__dirname, "..", "..", ".env") });

if (
  process.env.STRIPE_LOG_PRICE_ID_ON_BOOT === "1" ||
  process.env.NODE_ENV !== "production"
) {
  // 確認後は STRIPE_LOG_PRICE_ID_ON_BOOT を外すか、本番では NODE_ENV=production で抑制
  console.log("Price ID:", process.env.STRIPE_TEST_PRICE_ID ?? "");
}
