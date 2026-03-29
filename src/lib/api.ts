/**
 * API のベース URL（.env の VITE_API_URL）。App Runner / ローカル dev:api など。
 * 認証が必要なルート用に X-User-Id を付与（VITE_DEV_USER_ID）。Cognito 連携後は Authorization に切り替え可。
 */
const BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export function getApiBaseUrl() {
  return BASE;
}

/**
 * 全 API 呼び出しで共通。バックエンドは X-User-Id 必須のため常に付与する。
 * ビルド時に VITE_DEV_USER_ID を上書き可能（未設定時は "1"）。
 */
function headers(extra?: Record<string, string>) {
  const uid =
    import.meta.env.VITE_DEV_USER_ID ??
    import.meta.env.VITE_DEFAULT_USER_ID ??
    "1";
  return {
    "content-type": "application/json",
    "x-user-id": String(uid),
    ...extra,
  };
}

export async function getHealth() {
  const res = await fetch(`${BASE}/health`, { headers: headers() });
  return parse<{ ok: boolean }>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok) {
    const err = data as { error?: string; detail?: string };
    throw new Error(err.detail ?? err.error ?? res.statusText);
  }
  return data;
}

export async function getCategories() {
  const res = await fetch(`${BASE}/categories`, { headers: headers() });
  return parse<{ items: unknown[] }>(res);
}

export async function getTransactions(from?: string, to?: string) {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const qs = q.toString();
  const res = await fetch(`${BASE}/transactions${qs ? `?${qs}` : ""}`, {
    headers: headers(),
  });
  return parse<{ items: unknown[] }>(res);
}

export async function createTransaction(body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/transactions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return parse<{ id: number }>(res);
}
