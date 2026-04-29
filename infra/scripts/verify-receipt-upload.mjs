/**
 * 本番相当: ログイン後に POST /receipts/upload（multipart）→ 202 + jobId を確認。
 * CloudWatch では ECS の api ロググループに api.receipts.upload.enqueued が出る（Lambda ではない）。
 *
 * 必須: VERIFY_LOGIN_ID, VERIFY_LOGIN_PASSWORD
 * 任意: VERIFY_API_URL（既定 https://api.ksystemapp.com）
 */
const apiBase = (process.env.VERIFY_API_URL || "https://api.ksystemapp.com").replace(/\/$/, "");
const loginId = process.env.VERIFY_LOGIN_ID;
const password = process.env.VERIFY_LOGIN_PASSWORD;

/** 最小 JPEG（1x1 px）— 解析は失敗しうるがアップロード受理まで検証 */
const MIN_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

function requireEnv(name, v) {
  if (!v) throw new Error(`環境変数 ${name} が未設定です（verify-login と同じ ID/パスワードを使えます）`);
}

async function login() {
  requireEnv("VERIFY_LOGIN_ID", loginId);
  requireEnv("VERIFY_LOGIN_PASSWORD", password);
  const res = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: loginId, password }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`ログイン応答が JSON ではありません: ${text.slice(0, 200)}`);
  }
  if (!res.ok || !data?.token) {
    throw new Error(`ログイン失敗: ${res.status} ${data?.detail || data?.error || ""}`);
  }
  return data.token;
}

async function main() {
  const token = await login();
  const buf = Buffer.from(MIN_JPEG_B64, "base64");
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "image/jpeg" }), "verify-tiny.jpg");

  const res = await fetch(`${apiBase}/receipts/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`応答が JSON ではありません: ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status !== 202 || !j?.jobId) {
    throw new Error(`想定外: status=${res.status} body=${JSON.stringify(j).slice(0, 500)}`);
  }
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "verify.receipt_upload_ok",
      jobId: j.jobId,
      api: apiBase,
      hint: "CloudWatch: ECS api タスクのログ（/ecs/...）で api.receipts.upload.enqueued を検索。Lambda LogGroup には出ません。",
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
