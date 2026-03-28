/**
 * API Gateway HTTP API のベース URL（.env の VITE_API_URL に設定）
 * 暫定で X-User-Id を付与。Cognito 連携後は Authorization: Bearer <idToken> に切り替える。
 */
const BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export function getApiBaseUrl() {
  return BASE;
}

function headers(extra?: Record<string, string>) {
  const h: Record<string, string> = {
    "content-type": "application/json",
    ...extra,
  };
  const uid = import.meta.env.VITE_DEV_USER_ID;
  if (uid) h["x-user-id"] = String(uid);
  return h;
}

export async function getHealth() {
  const res = await fetch(`${BASE}/health`, {
    headers: { "content-type": "application/json" },
  });
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
