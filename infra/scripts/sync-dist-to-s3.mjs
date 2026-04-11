/**
 * dist/ の「中身だけ」を s3://<bucket>/kakeibo/ に同期する。
 *
 * NG: コンソールで dist フォルダごとアップロード → kakeibo/dist/index.html になる
 * OK: 本スクリプトまたは `aws s3 sync ./dist/ s3://.../kakeibo/`（dist に末尾 / を付ける）
 *
 * --delete により、kakeibo/ 配下にあってローカル dist に無いオブジェクトは削除される
 * （誤って作られた kakeibo/dist/ も消える）。
 *
 *   npm run deploy:s3-sync
 *
 * 環境変数: S3_BUCKET（既定: ksystemapp-web-production）, AWS_REGION（既定: ap-northeast-1）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extraS3CpFlagsForDistRootFile } from "./s3-root-file-content-type.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const bucket = process.env.S3_BUCKET || "ksystemapp-web-production";
const region = process.env.AWS_REGION || "ap-northeast-1";

function sh(cmd, opts = {}) {
  console.error(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: "inherit", cwd: opts.cwd ?? repoRoot, ...opts });
}

try {
  sh("aws sts get-caller-identity");
  sh("npm run build", { cwd: repoRoot });
  const distDir = path.join(repoRoot, "dist").replace(/\\/g, "/");
  const distPath = path.join(repoRoot, "dist");
  if (fs.existsSync(path.join(distPath, "assets"))) {
    sh(
      `aws s3 sync "${distDir}/assets/" "s3://${bucket}/kakeibo/assets/" --delete --region ${region} --cache-control "public,max-age=31536000,immutable"`,
    );
  }
  sh(
    `aws s3 cp "${distDir}/index.html" "s3://${bucket}/kakeibo/index.html" --region ${region} --cache-control "max-age=0,no-cache,no-store,must-revalidate" --content-type "text/html; charset=utf-8"`,
  );
  for (const name of fs.readdirSync(distPath)) {
    if (name === "assets" || name === "index.html") continue;
    const full = path.join(distPath, name);
    const unix = full.replace(/\\/g, "/");
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      sh(
        `aws s3 sync "${unix}/" "s3://${bucket}/kakeibo/${name}/" --delete --region ${region} --cache-control "public,max-age=86400"`,
      );
    } else if (st.isFile()) {
      const ct = extraS3CpFlagsForDistRootFile(name);
      sh(
        `aws s3 cp "${unix}" "s3://${bucket}/kakeibo/${name}" --region ${region} --cache-control "public,max-age=86400"${ct}`,
      );
    }
  }
  console.error(
    "\n完了。S3 上は kakeibo/index.html と kakeibo/assets/ 直下であることを確認してください（kakeibo/dist/ は不要）。\n",
  );
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
