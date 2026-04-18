/**
 * 完全自動: backend(App Runner) + frontend(S3/CloudFront) + ログイン疎通確認
 *
 * 実行:
 *   npm run deploy:auto
 *
 * 必須環境変数（verify 用）:
 *   VERIFY_LOGIN_ID, VERIFY_LOGIN_PASSWORD
 * 任意（verify-login.mjs 内の既定あり）:
 *   VERIFY_API_URL（既定: https://api.ksystemapp.com）
 *   VERIFY_APP_URL（既定: https://ksystemapp.com/kakeibo/login）
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function sh(cmd) {
  console.error(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: "inherit", cwd: repoRoot });
}

try {
  if (!process.env.VERIFY_APP_URL) {
    process.env.VERIFY_APP_URL = "https://ksystemapp.com/kakeibo/login";
  }
  sh("node infra/scripts/deploy-backend-apprunner.mjs");
  sh("node infra/scripts/deploy-production.mjs");
  sh("node infra/scripts/verify-login.mjs");
  console.error("\n完了。デプロイとログイン確認が成功しました。\n");
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
