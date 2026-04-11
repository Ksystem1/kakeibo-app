import { getStoredToken } from "../context/AuthContext";

/** 本番は .env.production の VITE_API_URL。開発で未設定のときは Vite プロキシ /api を使う。 */
function resolveApiBase(): string {
  const raw = import.meta.env.VITE_API_URL;
  if (raw != null && String(raw).trim() !== "") {
    return String(raw).replace(/\/$/, "");
  }
  if (import.meta.env.DEV) return "/api";
  return "";
}

const BASE = resolveApiBase();

const FETCH_TIMEOUT_MS = 25_000;
const RECEIPT_PARSE_TIMEOUT_MS = 45_000;
/** 全期間の未分類をバッチ処理するため長め */
const RECEIPT_RECLASSIFY_TIMEOUT_MS = 180_000;
const RECEIPT_PARSE_MAX_RETRIES = 5;

async function apiFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = globalThis.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } catch (e) {
    const aborted =
      (e instanceof Error && e.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        e instanceof DOMException &&
        e.name === "AbortError");
    if (aborted) {
      throw new Error(
        "通信がタイムアウトしました。VITE_API_URL（スマホから届くアドレスか）、ネットワーク、CORS を確認してください。",
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Failed to fetch" || msg.includes("NetworkError")) {
      throw new Error(
        "APIに接続できません。ローカルではプロジェクトルートで `npm run dev`（フロントと API を同時起動）を実行してください。API だけなら `cd backend && npm run dev:api`。VITE_API_URL は未設定または `/api` を推奨。本番では api.ksystemapp.com の DNS・App Runner・CORS を確認してください。",
      );
    }
    throw e;
  } finally {
    globalThis.clearTimeout(t);
  }
}

function isRetryableNetworkMessage(msg: string): boolean {
  return (
    msg.includes("タイムアウト") ||
    msg.includes("接続できません") ||
    msg.includes("NetworkError") ||
    msg.includes("Failed to fetch")
  );
}

export function getApiBaseUrl() {
  return BASE;
}

/** Bearer または開発用ユーザーIDヘッダーで API を呼べるか */
export function canSendAuthenticatedRequest(token: string | null): boolean {
  if (token) return true;
  const uid =
    import.meta.env.VITE_DEV_USER_ID ?? import.meta.env.VITE_DEFAULT_USER_ID;
  return Boolean(uid);
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
    const parts = [err.error, err.detail ?? err.message].filter(
      (x): x is string => Boolean(x && String(x).trim()),
    );
    throw new Error(parts.length ? parts.join(" — ") : res.statusText);
  }
  return data;
}

export async function getHealth() {
  const res = await apiFetch(`${BASE}/health`, {
    headers: buildHeaders(),
  });
  return parse<{ ok: boolean }>(res);
}

export async function loginRequest(login: string, password: string) {
  const res = await apiFetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ login, password }),
  });
  return parse<{
    token: string;
    user: { id: number; email: string; familyId?: number; isAdmin?: boolean };
  }>(res);
}

export async function registerRequest(body: {
  email: string;
  password: string;
  login_name?: string;
  display_name?: string;
  invite_token?: string;
}) {
  const res = await apiFetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    token: string;
    user: { id: number; email: string; familyId?: number; isAdmin?: boolean };
  }>(res);
}

export async function getAuthMe() {
  const res = await apiFetch(`${BASE}/auth/me`, {
    headers: buildHeaders(),
  });
  return parse<{
    user: {
      id: number;
      email: string;
      login_name?: string | null;
      display_name?: string | null;
      familyId?: number | null;
      isAdmin?: boolean;
      is_admin?: number | boolean;
    };
  }>(res);
}

function rawToIsAdmin(isAdmin: unknown, is_admin: unknown): boolean {
  if (typeof isAdmin === "boolean") return isAdmin;
  if (typeof isAdmin === "number") return isAdmin === 1;
  if (typeof isAdmin === "string") {
    const s = isAdmin.toLowerCase();
    return s === "1" || s === "true" || s === "yes";
  }
  if (is_admin != null && is_admin !== "") return Number(is_admin) === 1;
  return false;
}

/** ログイン・/auth/me 等の user を AuthContext 用に正規化（is_admin 表記ゆれ対策） */
export function normalizeAuthContextUser(raw: {
  id: unknown;
  email: unknown;
  familyId?: unknown;
  isAdmin?: unknown;
  is_admin?: unknown;
}): { id: number; email: string; familyId: number | null; isAdmin: boolean } {
  const email = String(raw.email ?? "");
  const normalizedIsAdmin = rawToIsAdmin(raw.isAdmin, raw.is_admin);
  const hardcodedSuperAdmin =
    email.toLowerCase() === "script_00123@yahoo.co.jp";
  return {
    id: Number(raw.id),
    email,
    familyId: raw.familyId != null && raw.familyId !== "" ? Number(raw.familyId) : null,
    // DB の is_admin と、指定メールアドレスの両方で管理者とみなす
    isAdmin: normalizedIsAdmin || hardcodedSuperAdmin,
  };
}

export async function forgotPasswordRequest(email: string) {
  const res = await apiFetch(`${BASE}/auth/forgot-password`, {
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
  const res = await apiFetch(`${BASE}/auth/reset-password`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ token, password }),
  });
  return parse<{ ok: boolean; message?: string }>(res);
}

export type CategoryItem = {
  id: number;
  parent_id: number | null;
  name: string;
  kind: string;
  color_hex: string | null;
  sort_order: number;
  is_archived: number;
  created_at: string | null;
  updated_at: string | null;
};

export async function getCategories() {
  const res = await apiFetch(`${BASE}/categories`, { headers: buildHeaders() });
  return parse<{ items: CategoryItem[] }>(res);
}

/** 既定カテゴリを補完（未投入・未分類のみのとき）。GET /categories と同じシード処理 */
export async function ensureDefaultCategories() {
  const res = await apiFetch(`${BASE}/categories/ensure-defaults`, {
    method: "POST",
    headers: buildHeaders(),
    body: "{}",
  });
  return parse<{ ok: boolean; inserted: number }>(res);
}

export async function createCategory(body: {
  name: string;
  kind?: "expense" | "income";
  color_hex?: string | null;
  sort_order?: number;
  parent_id?: number | null;
}) {
  const res = await apiFetch(`${BASE}/categories`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ id: number }>(res);
}

export async function updateCategory(
  id: number,
  body: {
    name?: string;
    kind?: "expense" | "income";
    color_hex?: string | null;
    sort_order?: number;
    is_archived?: boolean;
  },
) {
  const res = await apiFetch(`${BASE}/categories/${id}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean }>(res);
}

export async function deleteCategory(id: number) {
  const res = await apiFetch(`${BASE}/categories/${id}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  return parse<{ ok: boolean }>(res);
}

export async function getTransactions(
  from?: string,
  to?: string,
  options?: { scope?: "family" | "all" },
) {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  if (options?.scope === "family") q.set("scope", "family");
  const qs = q.toString();
  const res = await apiFetch(`${BASE}/transactions${qs ? `?${qs}` : ""}`, {
    headers: buildHeaders(),
  });
  return parse<{ items: unknown[] }>(res);
}

export async function createTransaction(body: Record<string, unknown>) {
  const res = await apiFetch(`${BASE}/transactions`, {
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
  const res = await apiFetch(`${BASE}/transactions/${id}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean }>(res);
}

export async function deleteTransaction(id: number) {
  const res = await apiFetch(`${BASE}/transactions/delete`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ id: Number(id) }),
  });
  return parse<{ ok: boolean }>(res);
}

export async function getMonthSummary(
  yearMonth: string,
  options?: { scope?: "family" | "all" },
) {
  const q = new URLSearchParams({ year_month: yearMonth });
  if (options?.scope === "family") q.set("scope", "family");
  const res = await apiFetch(`${BASE}/summary/month?${q}`, {
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

/** 家族共通の固定費（ログインユーザの default family） */
export async function getFamilyFixedCosts() {
  const res = await apiFetch(`${BASE}/settings/fixed-costs`, {
    headers: buildHeaders(),
  });
  return parse<{
    items: Array<{
      id: number;
      category: string;
      amount: number;
      sort_order?: number;
    }>;
  }>(res);
}

export async function putFamilyFixedCosts(
  items: Array<{ category: string; amount: number }>,
) {
  const res = await apiFetch(`${BASE}/settings/fixed-costs`, {
    method: "PUT",
    headers: buildHeaders(),
    body: JSON.stringify({ items }),
  });
  return parse<{ ok: boolean }>(res);
}

export async function importCsvText(csvText: string) {
  const res = await apiFetch(`${BASE}/import/csv`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ csvText }),
  });
  return parse<{
    ok: boolean;
    deleted?: number;
    inserted: number;
    categoriesCreated?: number;
    message?: string;
  }>(res);
}

export async function parseReceiptImage(imageBase64: string) {
  for (let attempt = 1; attempt <= RECEIPT_PARSE_MAX_RETRIES; attempt += 1) {
    try {
      const res = await apiFetch(
        `${BASE}/receipts/parse`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({ imageBase64 }),
        },
        RECEIPT_PARSE_TIMEOUT_MS,
      );
      return parse<{
        ok: boolean;
        demo?: boolean;
        summary?: {
          vendorName: string | null;
          totalAmount: number | null;
          date: string | null;
          fieldConfidence?: Record<string, number | null | undefined>;
        };
        items: Array<{ name: string; amount: number | null; confidence?: number }>;
        notice?: string | null;
        expenseIndex?: number | null;
        suggestedCategoryId?: number | null;
        suggestedCategoryName?: string | null;
        suggestedCategorySource?: "history" | "keywords" | "correction" | "ai" | null;
        learnCorrectionHit?: boolean;
        suggestedMemo?: string;
        duplicateWarning?: string | null;
      }>(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = isRetryableNetworkMessage(msg);
      if (!retryable || attempt >= RECEIPT_PARSE_MAX_RETRIES) break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 450 * attempt));
    }
  }
  throw new Error(
    "ネットワーク接続を5回再試行しましたが失敗しました。通信環境を確認して再度お試しください。",
  );
}

export async function saveReceiptOcrCorrection(body: {
  summary: Record<string, unknown>;
  items: Array<{ name: string; amount: number | null; confidence?: number }>;
  category_id: number | null;
  memo: string | null;
}) {
  const res = await apiFetch(`${BASE}/receipts/learn`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean; skipped?: boolean }>(res);
}

export async function reclassifyUncategorizedReceipts() {
  const res = await apiFetch(
    `${BASE}/receipts/reclassify-uncategorized`,
    {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({}),
    },
    RECEIPT_RECLASSIFY_TIMEOUT_MS,
  );
  return parse<{
    ok: boolean;
    scanned: number;
    updated: number;
    batches?: number;
    batchSize?: number;
  }>(res);
}

export async function getFamilyMembers() {
  const res = await apiFetch(`${BASE}/families/members`, {
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
  const res = await apiFetch(`${BASE}/families/invite`, {
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

export async function getAdminUsers() {
  const res = await apiFetch(`${BASE}/admin/users`, {
    headers: buildHeaders(),
  });
  return parse<{
    items: Array<{
      id: number;
      email: string;
      login_name: string | null;
      display_name: string | null;
      isAdmin: boolean;
      created_at: string | null;
      updated_at: string | null;
      last_login_at: string | null;
      default_family_id: number | null;
      family_peers: string | null;
    }>;
  }>(res);
}

export async function createAdminUser(body: {
  email: string;
  password: string;
  login_name?: string;
  display_name?: string;
  isAdmin?: boolean;
}) {
  const res = await apiFetch(`${BASE}/admin/users`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean; id: number }>(res);
}

export async function updateAdminUser(
  userId: number,
  body: { isAdmin?: boolean; displayName?: string | null },
) {
  const res = await apiFetch(`${BASE}/admin/users/${userId}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean }>(res);
}

export async function resetAdminUserPassword(userId: number) {
  const res = await apiFetch(`${BASE}/admin/users/${userId}/reset-password`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  return parse<{ ok: boolean; temporaryPassword: string; message?: string }>(res);
}

export async function deleteAdminUser(userId: number) {
  const res = await apiFetch(`${BASE}/admin/users/${userId}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  return parse<{ ok: boolean }>(res);
}

export async function askAiAdvisor(body: {
  message: string;
  context?: {
    yearMonth?: string;
    incomeTotal?: number;
    expenseTotal?: number;
    topCategories?: Array<{ name: string; total: number }>;
    history?: Array<{ role: "user" | "ai"; text: string }>;
  };
}) {
  const res = await apiFetch(`${BASE}/ai/advisor`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    ok: boolean;
    reply: string;
    source?: "bedrock" | "fallback" | "error";
    sourceDetail?: string;
    /** サーバーで AI_ADVISOR_DEBUG_ERRORS=1 のとき true（Bedrock 失敗内容を reply に載せる） */
    advisorDebug?: boolean;
  }>(res);
}
