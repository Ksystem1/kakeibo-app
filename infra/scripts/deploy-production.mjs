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

  try {
    sh(`aws s3api head-bucket --bucket ${bucket} --region ${region}`);
  } catch {
    console.error(
      `\n[deploy] バケット s3://${bucket}/ に現在の認証情報でアクセスできません（NoSuchBucket または権限不足）。\n` +
        `  ・GitHub Secret S3_BUCKET が別名・タイポ・削除済みバケットになっていないか確認\n` +
        `  ・レガシー名 ksystem-kakeibo-* は Terraform の旧 SPA 用です。未使用なら ksystemapp-web-production に合わせる\n` +
        `  ・AWS_REGION（${region}）がバケットのリージョンと一致しているか確認\n` +
        `  ・OIDC ロールの AWS アカウントがバケットと同じか確認\n`,
    );
    throw new Error("S3 head-bucket failed");
  }

  const viteApi = (process.env.VITE_API_URL || "").trim();
  if (process.env.GITHUB_ACTIONS === "true") {
    if (!viteApi) {
      console.error(
        "[deploy] GitHub Actions 上では Secrets に VITE_API_URL を設定してください（ビルド時に Vite が埋め込みます）。",
      );
      process.exit(1);
    }
    if (/^http:\/\//i.test(viteApi)) {
      console.error(
        "[deploy] HTTPS で配信しているフロントから http:// の API は Mixed Content でブロックされます。\n" +
          "対処: (1) ACM（ap-northeast-1）で api.<ドメイン> を発行し Terraform の alb_certificate_arn に指定して ALB に 443 を付ける\n" +
          "(2) Route53 で api.<ドメイン> を ALB にエイリアス\n" +
          "(3) GitHub Secret VITE_API_URL を https://api.<ドメイン> に変更\n" +
          "詳細: terraform output vite_api_url_mixed_content_note（ECS スタック）",
      );
      process.exit(1);
    }
  }

  sh("npm run build");

  if (viteApi && process.env.SKIP_VERIFY_VITE_EMBED !== "1") {
    sh("node infra/scripts/verify-vite-api-embed.mjs");
  }

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
