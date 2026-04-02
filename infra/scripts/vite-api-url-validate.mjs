/**
 * 本番ビルド用: VITE_API_URL が API のベース URL として妥当か検証する。
 * ACM 証明書 ARN を誤って設定すると、ブラウザで Failed to parse URL になる。
 */

/**
 * @param {string} raw
 * @param {{ githubActions?: boolean }} opts
 */
export function assertProductionViteApiUrl(raw, opts = {}) {
  const githubActions = Boolean(opts.githubActions);
  const v = String(raw ?? "").trim().replace(/\/$/, "");

  if (!v) {
    if (githubActions) {
      throw new Error(
        "VITE_API_URL が空です。GitHub Actions の Secret に https://api.ksystemapp.com（末尾スラッシュなし）を設定してください。",
      );
    }
    return;
  }

  if (/^arn:aws:/i.test(v)) {
    throw new Error(
      "VITE_API_URL に AWS の ARN（例: ACM 証明書 ARN）が入っています。API の HTTPS URL を設定してください（例: https://api.ksystemapp.com）。",
    );
  }

  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error(
      "VITE_API_URL が URL として解釈できません（ブラウザで Failed to parse URL になります）。https:// で始まる API の FQDN を設定してください。",
    );
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`VITE_API_URL のスキームが不正です（${u.protocol}）。https:// を使ってください。`);
  }

  if (githubActions && u.protocol !== "https:") {
    throw new Error(
      "GitHub Actions 本番デプロイでは VITE_API_URL は https:// 必須です（Mixed Content 防止）。例: https://api.ksystemapp.com",
    );
  }

  if (!u.hostname) {
    throw new Error("VITE_API_URL にホスト名がありません。");
  }
}
