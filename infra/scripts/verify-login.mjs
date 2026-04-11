/**
 * 本番のログイン疎通確認:
 * 1) GET /health（DB 含む）
 * 2) ログイン画面が配信されること
 * 3) POST /auth/login でトークン取得
 * 4) GET /auth/me でユーザー・isAdmin を確認
 *
 * 必須: VERIFY_LOGIN_ID, VERIFY_LOGIN_PASSWORD
 * 任意（既定あり）:
 *   VERIFY_APP_URL  既定 https://ksystemapp.com/kakeibo/login
 *   VERIFY_API_URL  既定 https://api.ksystemapp.com
 */
const appUrl =
  process.env.VERIFY_APP_URL || "https://ksystemapp.com/kakeibo/login";
const apiBase = (
  process.env.VERIFY_API_URL || "https://api.ksystemapp.com"
).replace(/\/$/, "");
const loginId = process.env.VERIFY_LOGIN_ID;
const password = process.env.VERIFY_LOGIN_PASSWORD;

function required(name, value) {
  if (!value) throw new Error(`環境変数 ${name} が未設定です`);
}

async function checkApiHealth() {
  const res = await fetch(`${apiBase}/health`);
  const text = await res.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`/health が JSON ではありません: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`/health 失敗: ${res.status} ${JSON.stringify(j)}`);
  }
  if (j.ok !== true) {
    throw new Error(`/health: ok が true ではありません: ${JSON.stringify(j)}`);
  }
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

/** @returns {Promise<string>} */
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
  return data.token;
}

async function checkAuthMe(token) {
  const res = await fetch(`${apiBase}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`/auth/me が JSON ではありません: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`/auth/me 失敗: ${res.status} ${JSON.stringify(data)}`);
  }
  const u = data?.user;
  if (!u?.id) {
    throw new Error("/auth/me に user.id がありません");
  }
  if (typeof u.isAdmin !== "boolean") {
    throw new Error(
      `/auth/me user.isAdmin が boolean ではありません: ${JSON.stringify(u.isAdmin)}`,
    );
  }
  if (u.subscriptionStatus != null && typeof u.subscriptionStatus !== "string") {
    throw new Error(
      `/auth/me user.subscriptionStatus が string ではありません: ${JSON.stringify(u.subscriptionStatus)}`,
    );
  }
  console.error(
    `verify-login: user id=${u.id} email=${u.email ?? ""} isAdmin=${u.isAdmin} subscriptionStatus=${u.subscriptionStatus ?? "(なし)"}`,
  );
}

try {
  required("VERIFY_LOGIN_ID", loginId);
  required("VERIFY_LOGIN_PASSWORD", password);

  await checkApiHealth();
  await checkAppPage();
  const token = await checkApiLogin();
  await checkAuthMe(token);
  console.error("verify-login: OK");
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
