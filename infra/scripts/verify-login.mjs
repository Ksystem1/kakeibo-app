/**
 * 本番のログイン疎通確認:
 * 1) ログイン画面が配信されること
 * 2) API /auth/login でトークン取得できること
 *
 * 必須環境変数:
 *   VERIFY_APP_URL       例: https://ksystemapp.com/kakeibo/login
 *   VERIFY_API_URL       例: https://api.ksystemapp.com
 *   VERIFY_LOGIN_ID      例: test_user@example.com または login_id
 *   VERIFY_LOGIN_PASSWORD
 */
const appUrl = process.env.VERIFY_APP_URL;
const apiBase = process.env.VERIFY_API_URL?.replace(/\/$/, "");
const loginId = process.env.VERIFY_LOGIN_ID;
const password = process.env.VERIFY_LOGIN_PASSWORD;

function required(name, value) {
  if (!value) throw new Error(`環境変数 ${name} が未設定です`);
}

async function checkAppPage() {
  const res = await fetch(appUrl, { method: "GET" });
  if (!res.ok) {
    throw new Error(`ログイン画面取得失敗: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  if (!html.includes("ログイン")) {
    throw new Error("ログイン画面のHTMLに「ログイン」が見つかりません");
  }
}

async function checkApiLogin() {
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
    throw new Error(`ログインAPI応答がJSONではありません: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data?.detail || data?.message || data?.error || res.statusText;
    throw new Error(`ログインAPI失敗: ${res.status} ${msg}`);
  }
  if (!data?.token) {
    throw new Error("ログインAPIは成功したが token がありません");
  }
}

try {
  required("VERIFY_APP_URL", appUrl);
  required("VERIFY_API_URL", apiBase);
  required("VERIFY_LOGIN_ID", loginId);
  required("VERIFY_LOGIN_PASSWORD", password);

  await checkAppPage();
  await checkApiLogin();
  console.error("verify-login: OK");
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
