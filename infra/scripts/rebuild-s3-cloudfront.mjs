/**
 * 復旧用: S3 新規バケット → ビルド → kakeibo/ へ sync → バケットポリシー → CloudFront オリジン差し替え
 *
 * 1) バケット ksystemapp-web-production を作成（無い場合のみ）
 * 2) npm run build → dist/ を s3://.../kakeibo/ に sync
 * 3) 既存 CloudFront の第 1 オリジンを新バケットのリージョナルドメインに変更（既に一致ならスキップ）
 * 4) SPA 対策: 403/404 を /{APP_PATH_PREFIX}/index.html を 200 で返すカスタムエラー応答に設定（未設定または不一致なら更新）
 *    ※オブジェクトは s3://.../kakeibo/ 配下のため応答ページは /kakeibo/index.html（バケット直下の /index.html ではない）
 * 5) CloudFront からの GetObject を許可するバケットポリシー（SourceArn 条件付き）
 * 6) CloudFront キャッシュ無効化 paths: /*
 *
 * 使い方（プロジェクトルート）:
 *   npm run deploy:s3-rebuild
 *   node infra/scripts/rebuild-s3-cloudfront.mjs [CloudFrontのID]
 *
 * 環境変数:
 *   S3_BUCKET（既定: ksystemapp-web-production）
 *   AWS_REGION（既定: ap-northeast-1）※バケットとオリジンドメインのリージョン
 *   CLOUDFRONT_DISTRIBUTION_ID（複数ディストリビューションがあるとき必須）
 *   APP_PATH_PREFIX（既定: kakeibo）— カスタムエラー応答の ResponsePagePath に使う
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const bucket = process.env.S3_BUCKET || "ksystemapp-web-production";
const region = process.env.AWS_REGION || "ap-northeast-1";
const appPathPrefix = process.env.APP_PATH_PREFIX || "kakeibo";
let distId = process.env.CLOUDFRONT_DISTRIBUTION_ID || process.argv[2] || "";

function sh(cmd, opts = {}) {
  const { cwd, silent, ...rest } = opts;
  console.error(`\n> ${cmd}\n`);
  return execSync(cmd, {
    encoding: "utf8",
    stdio: silent ? "pipe" : "inherit",
    cwd,
    ...rest,
  });
}

function awsJson(args) {
  const cmd = `aws ${args} --output json`;
  console.error(`\n> ${cmd}\n`);
  return JSON.parse(execSync(cmd, { encoding: "utf8" }));
}

function bucketExists() {
  try {
    execSync(`aws s3api head-bucket --bucket ${bucket} --region ${region}`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function createBucket() {
  if (bucketExists()) {
    console.error(`バケットは既にあります: ${bucket}`);
    return;
  }
  if (region === "us-east-1") {
    sh(`aws s3api create-bucket --bucket ${bucket} --region ${region}`);
  } else {
    sh(
      `aws s3api create-bucket --bucket ${bucket} --region ${region} --create-bucket-configuration LocationConstraint=${region}`,
    );
  }
}

function lockdownBucket() {
  sh(
    `aws s3api put-public-access-block --bucket ${bucket} --public-access-block-configuration ` +
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
  );
}

function resolveDistributionId() {
  if (distId) return distId;
  const data = awsJson("cloudfront list-distributions");
  const items = data.DistributionList?.Items ?? [];
  if (items.length === 0) {
    throw new Error(
      "CloudFront ディストリビューションが見つかりません。コンソールで作成するか CLOUDFRONT_DISTRIBUTION_ID を指定してください。",
    );
  }
  if (items.length > 1) {
    console.error("複数のディストリビューションがあります。ID を指定してください:");
    for (const it of items) {
      console.error(`  ${it.Id}\t${it.Comment || ""}\t${it.DomainName}`);
    }
    throw new Error("環境変数 CLOUDFRONT_DISTRIBUTION_ID または引数で ID を渡してください。");
  }
  distId = items[0].Id;
  console.error(`自動選択した Distribution ID: ${distId}`);
  return distId;
}

function putBucketPolicy(accountId, distributionArn) {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowCloudFrontServiceRead",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: {
          StringEquals: { "AWS:SourceArn": distributionArn },
        },
      },
    ],
  };
  const tmp = path.join(__dirname, ".bucket-policy-temp.json");
  fs.writeFileSync(tmp, JSON.stringify(policy), "utf8");
  const urlPath = tmp.replace(/\\/g, "/");
  sh(`aws s3api put-bucket-policy --bucket ${bucket} --policy file://${urlPath}`);
  fs.unlinkSync(tmp);
}

function spaErrorItemSig(x) {
  return `${x.ErrorCode}|${x.ResponsePagePath}|${String(x.ResponseCode)}|${x.ErrorCachingMinTTL ?? 0}`;
}

/** 403（S3 プライベート時の Missing key 等）と 404 を SPA の index にフォールバック */
function mergeSpaErrorResponses(cfg) {
  const pagePath = `/${appPathPrefix}/index.html`;
  const spaItems = [
    {
      ErrorCode: 403,
      ResponsePagePath: pagePath,
      ResponseCode: "200",
      ErrorCachingMinTTL: 0,
    },
    {
      ErrorCode: 404,
      ResponsePagePath: pagePath,
      ResponseCode: "200",
      ErrorCachingMinTTL: 0,
    },
  ];
  const oldItems = cfg.CustomErrorResponses?.Items ?? [];
  const kept = oldItems.filter((x) => x.ErrorCode !== 403 && x.ErrorCode !== 404);
  const merged = [...kept, ...spaItems].sort((a, b) => a.ErrorCode - b.ErrorCode);
  const oldSigs = new Set(oldItems.map(spaErrorItemSig));
  const mergedSigs = new Set(merged.map(spaErrorItemSig));
  if (oldSigs.size === mergedSigs.size && [...mergedSigs].every((s) => oldSigs.has(s))) {
    return false;
  }
  cfg.CustomErrorResponses = { Quantity: merged.length, Items: merged };
  return true;
}

function syncCloudFrontSettings() {
  const raw = awsJson(`cloudfront get-distribution-config --id ${distId}`);
  const etag = raw.ETag;
  const cfg = raw.DistributionConfig;
  const regionalDomain = `${bucket}.s3.${region}.amazonaws.com`;

  const items = cfg.Origins?.Items ?? [];
  if (items.length === 0) throw new Error("DistributionConfig にオリジンがありません。");

  let changed = false;
  if (items[0].DomainName !== regionalDomain) {
    items[0].DomainName = regionalDomain;
    items[0].Id = items[0].Id || "s3-spa";
    if (!items[0].S3OriginConfig) {
      items[0].S3OriginConfig = { OriginAccessIdentity: "" };
    } else {
      items[0].S3OriginConfig.OriginAccessIdentity = "";
    }
    changed = true;
    console.error(`第1オリジンを ${regionalDomain} に更新します。`);
  } else {
    console.error(`第1オリジンは既に ${regionalDomain} です。`);
  }

  const originPath = items[0].OriginPath || "";
  if (originPath) {
    console.error(
      `[警告] 第1オリジンの Origin path が "${originPath}" です。` +
        `kakeibo/index.html 構成では空が一般的です（値があるとパスが二重になり NotFound になります）。`,
    );
  }

  if (mergeSpaErrorResponses(cfg)) {
    changed = true;
    console.error(
      `カスタムエラー応答を設定しました: 403/404 → /${appPathPrefix}/index.html (200)`,
    );
  } else {
    console.error("カスタムエラー応答（403/404 SPA）は既に想定どおりです。");
  }

  if (!changed) {
    console.error("CloudFront ディストリビューション設定の更新は不要です。");
    return;
  }

  const outPath = path.join(__dirname, ".cf-distribution-config.json");
  fs.writeFileSync(outPath, JSON.stringify(cfg), "utf8");
  const fileUrl = outPath.replace(/\\/g, "/");
  sh(
    `aws cloudfront update-distribution --id ${distId} --if-match ${etag} --distribution-config file://${fileUrl}`,
  );
  fs.unlinkSync(outPath);
}

function main() {
  sh("aws sts get-caller-identity");

  createBucket();
  lockdownBucket();

  sh("npm run build", { cwd: repoRoot });

  // distDir 末尾は必ず /（中身が kakeibo/ 直下に乗る。kakeibo/dist/ になるとサイトが 404）
  const distDir = path.join(repoRoot, "dist").replace(/\\/g, "/");
  sh(`aws s3 sync "${distDir}/" "s3://${bucket}/kakeibo/" --delete --region ${region}`);

  resolveDistributionId();
  const account = execSync("aws sts get-caller-identity --query Account --output text", {
    encoding: "utf8",
  }).trim();
  const distributionArn = `arn:aws:cloudfront::${account}:distribution/${distId}`;

  putBucketPolicy(account, distributionArn);
  syncCloudFrontSettings();

  sh(
    `aws cloudfront create-invalidation --distribution-id ${distId} --paths "/*"`,
  );

  console.error(
    "\n完了。CloudFront の設定反映まで数分かかることがあります。URL: https://ksystemapp.com/kakeibo/\n",
  );
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
