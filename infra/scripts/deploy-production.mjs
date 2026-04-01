/**
 * 本番反映用: ビルド → S3 sync(kakeibo/) → CloudFront invalidation(/*)
 *
 * 使い方:
 *   npm run deploy:prod
 *   # 複数 Distribution がある場合:
 *   # CLOUDFRONT_DISTRIBUTION_ID=EXXXXX npm run deploy:prod
 *
 * 環境変数:
 *   S3_BUCKET（既定: ksystemapp-web-production）
 *   AWS_REGION（既定: ap-northeast-1）
 *   CLOUDFRONT_DISTRIBUTION_ID（複数 Distribution がある場合は必須）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const bucket = process.env.S3_BUCKET || "ksystemapp-web-production";
const region = process.env.AWS_REGION || "ap-northeast-1";
let distId = process.env.CLOUDFRONT_DISTRIBUTION_ID || "";

function sh(cmd, opts = {}) {
  console.error(`\n> ${cmd}\n`);
  return execSync(cmd, {
    encoding: "utf8",
    stdio: "inherit",
    cwd: opts.cwd ?? repoRoot,
    ...opts,
  });
}

function awsJson(args) {
  const cmd = `aws ${args} --output json`;
  console.error(`\n> ${cmd}\n`);
  return JSON.parse(execSync(cmd, { encoding: "utf8" }));
}

function resolveDistributionId() {
  if (distId) return distId;
  const data = awsJson("cloudfront list-distributions");
  const items = data.DistributionList?.Items ?? [];
  if (items.length === 0) {
    throw new Error("CloudFront ディストリビューションが見つかりません。");
  }
  if (items.length > 1) {
    console.error("複数のディストリビューションがあります。ID を指定してください:");
    for (const it of items) {
      console.error(`  ${it.Id}\t${it.Comment || ""}\t${it.DomainName}`);
    }
    throw new Error("環境変数 CLOUDFRONT_DISTRIBUTION_ID を指定してください。");
  }
  distId = items[0].Id;
  console.error(`自動選択した Distribution ID: ${distId}`);
  return distId;
}

try {
  sh("aws sts get-caller-identity");
  sh("npm run build");

  const distDir = path.join(repoRoot, "dist").replace(/\\/g, "/");
  const distPath = path.join(repoRoot, "dist");

  // ハッシュ付き JS/CSS は長期キャッシュ、index.html は毎回再検証（古いバンドル参照の取り違え防止）
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
    if (fs.statSync(full).isFile()) {
      const unix = full.replace(/\\/g, "/");
      sh(
        `aws s3 cp "${unix}" "s3://${bucket}/kakeibo/${name}" --region ${region} --cache-control "public,max-age=86400"`,
      );
    }
  }

  resolveDistributionId();
  sh(`aws cloudfront create-invalidation --distribution-id ${distId} --paths "/*"`);

  console.error("\n完了。https://ksystemapp.com/kakeibo/ を確認してください。\n");
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
