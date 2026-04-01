import { getStoredToken } from "../context/AuthContext";

const BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export function getApiBaseUrl() {
  return BASE;
}

function buildHeaders(extra?: Record<string, string>) {
  const h: Record<string, string> = {
    "content-type": "application/json",
    ...extra,
  };
  const token =
    typeof window !== "undefined" ? getStoredToken() : null;
  if (token) {
    h.authorization = `Bearer ${token}`;
    return h;
  }
  const uid =
    import.meta.env.VITE_DEV_USER_ID ??
    import.meta.env.VITE_DEFAULT_USER_ID;
  if (uid) {
    h["x-user-id"] = String(uid);
  }
  return h;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok) {
    const err = data as { error?: string; detail?: string; message?: string };
    throw new Error(
      err.detail ?? err.message ?? err.error ?? res.statusText,
    );
  }
  return data;
}

export async function getHealth() {
  const res = await fetch(`${BASE}/health`, {
    headers: buildHeaders(),
  });
  return parse<{ ok: boolean }>(res);
}

export async function loginRequest(login: string, password: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ login, password }),
  });
  return parse<{
    token: string;
    user: { id: number; email: string; familyId?: number };
  }>(res);
}

export async function registerRequest(body: {
  email: string;
  password: string;
  login_name?: string;
  display_name?: string;
  family_name?: string;
  invite_token?: string;
}) {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    token: string;
    user: { id: number; email: string; familyId?: number };
  }>(res);
}

export async function forgotPasswordRequest(email: string) {
  const res = await fetch(`${BASE}/auth/forgot-password`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ email }),
  });
  return parse<{
    ok: boolean;
    message?: string;
    debug_reset_token?: string;
    hint?: string;
  }>(res);
}

export async function resetPasswordRequest(token: string, password: string) {
  const res = await fetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ token, password }),
  });
  return parse<{ ok: boolean; message?: string }>(res);
}

export async function getCategories() {
  const res = await fetch(`${BASE}/categories`, { headers: buildHeaders() });
  return parse<{ items: unknown[] }>(res);
}

export async function getTransactions(from?: string, to?: string) {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const qs = q.toString();
  const res = await fetch(`${BASE}/transactions${qs ? `?${qs}` : ""}`, {
    headers: buildHeaders(),
  });
  return parse<{ items: unknown[] }>(res);
}

export async function createTransaction(body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/transactions`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ id: number }>(res);
}

export async function updateTransaction(
  id: number,
  body: Record<string, unknown>,
) {
  const res = await fetch(`${BASE}/transactions/${id}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean }>(res);
}

export async function deleteTransaction(id: number) {
  const res = await fetch(`${BASE}/transactions/delete`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ id: Number(id) }),
  });
  return parse<{ ok: boolean }>(res);
}

export async function getMonthSummary(yearMonth: string) {
  const q = new URLSearchParams({ year_month: yearMonth });
  const res = await fetch(`${BASE}/summary/month?${q}`, {
    headers: buildHeaders(),
  });
  return parse<{
    year_month: string;
    expenseTotal: unknown;
    incomeTotal: unknown;
    expensesByCategory: Array<{
      category_id: number | null;
      category_name: string | null;
      total: unknown;
    }>;
    incomesByCategory: Array<{
      category_id: number | null;
      category_name: string | null;
      total: unknown;
    }>;
  }>(res);
}

export async function importCsvText(csvText: string) {
  const res = await fetch(`${BASE}/import/csv`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ csvText }),
  });
  return parse<{ ok: boolean; inserted: number; message?: string }>(res);
}

export async function parseReceiptImage(imageBase64: string) {
  const res = await fetch(`${BASE}/receipts/parse`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ imageBase64 }),
  });
  return parse<{
    ok: boolean;
    items: Array<{ name: string; amount: number | null; confidence?: number }>;
    apis?: Record<string, string>;
    notice?: string;
  }>(res);
}

export async function getFamilyMembers() {
  const res = await fetch(`${BASE}/families/members`, {
    headers: buildHeaders(),
  });
  return parse<{
    familyId: number;
    items: Array<{
      id: number;
      email: string;
      display_name: string | null;
      role: string;
    }>;
  }>(res);
}

export async function inviteFamilyMember(email: string) {
  const res = await fetch(`${BASE}/families/invite`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ email }),
  });
  return parse<{
    ok: boolean;
    message?: string;
    debug_invite_token?: string;
    invite_url?: string;
    line_share_url?: string;
    line_message_share_url?: string;
  }>(res);
}
