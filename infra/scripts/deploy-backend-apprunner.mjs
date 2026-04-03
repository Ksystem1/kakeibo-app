/**
 * App Runner のバックエンドを再デプロイし、完了まで待機する。
 *
 * 注意:
 * - 現在の本番は ECS + ALB が正系です。
 * - ECS は .github/workflows/deploy.yml（Build+Push+Terraform apply）で更新してください。
 *
 * 実行:
 *   npm run deploy:backend:apprunner
 *
 * 必須環境変数:
 *   APP_RUNNER_SERVICE_ARN
 * 任意:
 *   AWS_REGION（既定: ap-northeast-1）
 *   APP_RUNNER_DEPLOY_TIMEOUT_SEC（既定: 900）
 */
import { execSync } from "node:child_process";

const serviceArn = process.env.APP_RUNNER_SERVICE_ARN || "";
const region = process.env.AWS_REGION || "ap-northeast-1";
const timeoutSec = Number(process.env.APP_RUNNER_DEPLOY_TIMEOUT_SEC || "900");

function sh(cmd, silent = false) {
  console.error(`\n> ${cmd}\n`);
  return execSync(cmd, {
    encoding: "utf8",
    stdio: silent ? "pipe" : "inherit",
  });
}

function awsJson(args) {
  return JSON.parse(sh(`aws ${args} --region ${region} --output json`, true));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (!serviceArn) {
  console.error("APP_RUNNER_SERVICE_ARN が未設定のため App Runner デプロイをスキップします。");
  console.error("現在の本番運用は ECS + ALB です。GitHub Actions の deploy.yml を使用してください。");
  process.exit(0);
}

try {
  sh("aws sts get-caller-identity");
  const start = awsJson(`apprunner start-deployment --service-arn "${serviceArn}"`);
  const opId = start.OperationId;
  if (!opId) throw new Error("start-deployment の OperationId が取得できませんでした。");
  console.error(`OperationId: ${opId}`);

  const startedAt = Date.now();
  while (true) {
    const op = awsJson(`apprunner list-operations --service-arn "${serviceArn}"`);
    const item = (op.OperationSummaryList || []).find((x) => x.Id === opId);
    const status = item?.Status || "UNKNOWN";
    console.error(`App Runner deployment status: ${status}`);
    if (status === "SUCCEEDED") {
      console.error("App Runner backend deploy が完了しました。");
      break;
    }
    if (status === "FAILED" || status === "ROLLBACK_FAILED") {
      throw new Error(`App Runner backend deploy 失敗: ${status}`);
    }
    if ((Date.now() - startedAt) / 1000 > timeoutSec) {
      throw new Error("App Runner backend deploy がタイムアウトしました。");
    }
    sleep(10000);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
