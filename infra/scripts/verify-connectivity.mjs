/**
 * 疎通確認（認証情報なしでも API・ログイン画面を検査可能）
 *
 * 既定:
 *   VERIFY_API_URL 未設定 → https://api.ksystemapp.com
 *   VERIFY_APP_URL 未設定 → https://ksystemapp.com/kakeibo/login
 *
 * 任意（設定時のみ）:
 *   VERIFY_LOGIN_ID, VERIFY_LOGIN_PASSWORD → POST /auth/login と GET /auth/me まで実行
 */
const apiBase = (
  process.env.VERIFY_API_URL || "https://api.ksystemapp.com"
).replace(/\/$/, "");
const appUrl =
  process.env.VERIFY_APP_URL || "https://ksystemapp.com/kakeibo/login";

async function step(name, fn) {
  try {
    await fn();
    console.error(`OK  ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`NG  ${name}: ${msg}`);
    throw e;
  }
}

async function main() {
  await step(`GET ${apiBase}/health`, async () => {
    const res = await fetch(`${apiBase}/health`);
    const text = await res.text();
    let j = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`JSON でない応答: ${text.slice(0, 120)}`);
    }
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`,
      );
    }
    if (j.ok !== true) {
      throw new Error(`期待: ok:true, 実際: ${JSON.stringify(j)}`);
    }
  });

  await step(`GET ${apiBase}/`, async () => {
    const res = await fetch(`${apiBase}/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.service !== "kakeibo-api") {
      throw new Error(`service が kakeibo-api ではない: ${j.service}`);
    }
  });

  await step(`GET ログイン画面 (${appUrl})`, async () => {
    const res = await fetch(appUrl, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    if (!html.includes("ログイン")) {
      throw new Error("HTML に「ログイン」が含まれません");
    }
  });

  const loginId = process.env.VERIFY_LOGIN_ID;
  const password = process.env.VERIFY_LOGIN_PASSWORD;
  if (loginId && password) {
    let token = "";
    await step("POST /auth/login", async () => {
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
        throw new Error(`JSON でない: ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        const msg = data?.detail || data?.message || data?.error || "";
        throw new Error(`HTTP ${res.status} ${msg}`);
      }
      if (!data?.token) throw new Error("token がありません");
      token = data.token;
    });

    await step("GET /auth/me", async () => {
      const res = await fetch(`${apiBase}/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`JSON でない: ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
      }
      const u = data?.user;
      if (!u?.id) throw new Error("user.id がありません");
      console.error(
        `    user: id=${u.id} email=${u.email ?? ""} isAdmin=${u.isAdmin}`,
      );
    });
  } else {
    console.error(
      "SKIP POST /auth/login, GET /auth/me（VERIFY_LOGIN_ID / VERIFY_LOGIN_PASSWORD 未設定）",
    );
  }

  console.error("\nverify-connectivity: 完了\n");
}

main().catch(() => process.exit(1));
