/**
 * S3 に kakeibo/index.html があるのに /kakeibo/ で S3 の NotFound XML になるときの修正用。
 *
 * 原因: S3 REST は「ディレクトリの index.html」を自動で返さない。/kakeibo/ はキー kakeibo/ を参照し 404。
 * 対策: CloudFront のカスタムエラーで 403/404 を /kakeibo/index.html を 200 で返す。
 *
 *   npm run deploy:cloudfront-spa
 *
 * 環境変数: CLOUDFRONT_DISTRIBUTION_ID（複数ディストリビューション時は必須）, APP_PATH_PREFIX（既定: kakeibo）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPathPrefix = process.env.APP_PATH_PREFIX || "kakeibo";
let distId = process.env.CLOUDFRONT_DISTRIBUTION_ID || process.argv[2] || "";

function sh(cmd, opts = {}) {
  console.error(`\n> ${cmd}\n`);
  return execSync(cmd, { encoding: "utf8", stdio: "inherit", ...opts });
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
    throw new Error("環境変数 CLOUDFRONT_DISTRIBUTION_ID または引数で ID を渡してください。");
  }
  distId = items[0].Id;
  console.error(`Distribution ID: ${distId}`);
  return distId;
}

function spaErrorItemSig(x) {
  return `${x.ErrorCode}|${x.ResponsePagePath}|${String(x.ResponseCode)}|${x.ErrorCachingMinTTL ?? 0}`;
}

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

function main() {
  sh("aws sts get-caller-identity");
  resolveDistributionId();

  const raw = awsJson(`cloudfront get-distribution-config --id ${distId}`);
  const etag = raw.ETag;
  const cfg = raw.DistributionConfig;

  const origins = cfg.Origins?.Items ?? [];
  if (origins.length > 0) {
    const op = origins[0].OriginPath || "";
    if (op) {
      console.error(
        `\n[警告] 第1オリジンの Origin path が "${op}" です。` +
          `オブジェクトが s3://.../kakeibo/index.html の構成なら、Origin path は通常「空」にしてください。` +
          `値があるとリクエストパスが二重になり NotFound になります。\n`,
      );
    }
  }

  if (!mergeSpaErrorResponses(cfg)) {
    console.error("カスタムエラー応答は既に 403/404 → SPA index です。Invalidation のみ実行します。");
  } else {
    const outPath = path.join(__dirname, ".cf-distribution-config.json");
    fs.writeFileSync(outPath, JSON.stringify(cfg), "utf8");
    const fileUrl = outPath.replace(/\\/g, "/");
    sh(
      `aws cloudfront update-distribution --id ${distId} --if-match ${etag} --distribution-config file://${fileUrl}`,
    );
    fs.unlinkSync(outPath);
    console.error(
      `\nカスタムエラーを設定しました: 403/404 → /${appPathPrefix}/index.html (200)。デプロイ完了まで数分かかります。\n`,
    );
  }

  sh(`aws cloudfront create-invalidation --distribution-id ${distId} --paths "/*"`);
  console.error("\nInvalidation 送信済み。https://ksystemapp.com/kakeibo/ を再読み込みしてください。\n");
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
