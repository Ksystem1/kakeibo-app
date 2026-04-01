/**
 * 本番ビルド後: dist の JS に VITE_API_URL の値が埋め込まれているか確認する。
 * GitHub Actions から deploy-production.mjs 経由で実行想定。
 *
 * 環境変数 VITE_API_URL が未設定のときは何もしない（ローカル .env.production のみのビルド向け）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const expect = (process.env.VITE_API_URL || "").trim().replace(/\/$/, "");
if (!expect) {
  console.error("verify-vite-api-embed: VITE_API_URL 未設定のためスキップ");
  process.exit(0);
}

const assetsDir = path.join(repoRoot, "dist", "assets");
if (!fs.existsSync(assetsDir)) {
  console.error("verify-vite-api-embed: dist/assets がありません");
  process.exit(1);
}

const jsFiles = fs
  .readdirSync(assetsDir)
  .filter((f) => f.endsWith(".js") && f.startsWith("index-"));
if (jsFiles.length === 0) {
  console.error("verify-vite-api-embed: index-*.js が見つかりません");
  process.exit(1);
}

let found = false;
for (const name of jsFiles) {
  const text = fs.readFileSync(path.join(assetsDir, name), "utf8");
  if (text.includes(expect)) {
    found = true;
    console.error(`verify-vite-api-embed: OK (${name} に ${expect} を確認)`);
    break;
  }
}

if (!found) {
  console.error(
    "verify-vite-api-embed: バンドル内に VITE_API_URL と一致する文字列がありません。ビルド時に環境変数が渡っているか確認してください。",
  );
  process.exit(1);
}
