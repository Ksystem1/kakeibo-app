import { getStoredToken } from "../context/AuthContext";
import { isSubscriptionServiceSubscribedClient } from "./subscriptionAccess";
import {
  aggregateAdminSalesLogsByDay,
  isApiRouteNotFoundError,
} from "./adminSalesDailyFromLogs";

/**
 * 開発（import.meta.env.DEV）では環境変数を使わず、API を常にこのオリジンに固定する。
 * 本番は VITE_API_URL 等を使用。
 */
const DEV_FORCED_API_BASE = String(
  import.meta.env.VITE_DEV_API_BASE || "http://127.0.0.1:3456/api",
).replace(/\/$/, "");

function resolveApiBase(): string {
  if (import.meta.env.DEV) {
    return DEV_FORCED_API_BASE;
  }
  const raw = import.meta.env.VITE_API_URL;
  if (raw != null && String(raw).trim() !== "") {
    let u = String(raw).replace(/\/$/, "");
    if (String(import.meta.env.VITE_API_APPEND_PREFIX ?? "").trim() === "1") {
      if (!/\/api$/i.test(u)) u = `${u}/api`;
    }
    return u;
  }
  // 本番ビルドで VITE_API_URL が空でも API 呼び出しを落とさないための既定。
  return "https://api.ksystemapp.com";
}

/** GET /config（開発は固定 URL、本番は VITE_STRIPE_CONFIG_URL または BASE/config） */
function resolveStripeConfigUrl(): string {
  if (import.meta.env.DEV) {
    return `${DEV_FORCED_API_BASE}/config`;
  }
  const full = String(import.meta.env.VITE_STRIPE_CONFIG_URL ?? "").trim();
  if (full) return full;
  return `${resolveApiBase()}/config`;
}

/** 必ず `?t=` でキャッシュ無効化（本番も同様） */
function resolveStripeConfigUrlForFetch(): string {
  const u = resolveStripeConfigUrl();
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}t=${Date.now()}`;
}

/**
 * 開発時: 実際に叩く URL をコンソールに出す（Vite 未設定時は相対 /api → プロキシで 127.0.0.1:3456）
 */
export function logStripeConfigRequestPlan(): void {
  if (!import.meta.env.DEV || typeof console === "undefined" || !console.debug) return;
  console.debug(
    "[api] DEV 固定:",
    DEV_FORCED_API_BASE,
    "→ GET",
    resolveStripeConfigUrl(),
    "+ ?t=（キャッシュ無効）",
  );
}

/** 設定画面のボタン活性: Checkout 可能または Price ID がサーバーで取れているとき */
export function isStripeCheckoutUiReady(status: BillingStripeStatus): boolean {
  return Boolean(status.checkoutReady || status.priceIdConfigured);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function isLoginNetworkRetryableErrorMessage(msg: string): boolean {
  return isRetryableNetworkMessage(msg) || msg.includes("fetch") || msg.includes("ECONN");
}

export function getApiBaseUrl() {
  return BASE;
}

export function toFriendlyPasskeyErrorMessage(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");
  const normalized = msg.trim();
  if (!normalized) return "パスキー認証に失敗しました。もう一度お試しください。";

  if (
    /operation either timed out or was not allowed/i.test(normalized) ||
    /NotAllowedError/i.test(normalized)
  ) {
    return "パスキー認証がキャンセルされたか、時間切れになりました。もう一度お試しください。";
  }
  if (/challenge/i.test(normalized)) {
    return "認証情報の確認に失敗しました。ページを再読み込みして、もう一度お試しください。";
  }
  if (/InvalidStateError/i.test(normalized)) {
    return "この端末では既に登録済みのパスキーです。別のパスキーをお試しください。";
  }
  return normalized;
}

export function toFriendlyLoginErrorMessage(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");
  const normalized = msg.trim();
  if (!normalized) return "ログインに失敗しました。もう一度お試しください。";
  if (/invalid credentials|invalid password|unauthorized|認証されていません/i.test(normalized)) {
    return "メールアドレス（またはログインID）かパスワードが違います。";
  }
  if (/user not found|not found|存在しません/i.test(normalized)) {
    return "入力したアカウントが見つかりません。";
  }
  if (/too many requests|rate limit|429/i.test(normalized)) {
    return "試行回数が多いため、一時的にログインできません。少し待ってから再試行してください。";
  }
  if (/network|failed to fetch|timed out|タイムアウト|接続できません/i.test(normalized)) {
    return "通信状態が不安定なためログインできませんでした。電波の良い場所で再試行してください。";
  }
  if (/internal|server|500|502|503|504/i.test(normalized)) {
    return "サーバー側で一時的なエラーが発生しました。時間をおいて再試行してください。";
  }
  return normalized;
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
    const err = data as { error?: string; detail?: string; message?: string; messageJa?: string };
    const messageJa = String(err.messageJa ?? "").trim();
    const detail = String(err.detail ?? err.message ?? "").trim();
    const code = String(err.error ?? "").trim();
    const msg = messageJa || detail || code || res.statusText;
    throw new Error(msg);
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
  const maxRetries = 2;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await apiFetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ login, password }),
      });
      return await parse<{
        token: string;
        user: {
          id: number;
          email: string;
          familyId?: number | null;
          familyRole?: string;
          family_role?: string;
          kidTheme?: string | null;
          kid_theme?: string | null;
          isChild?: boolean;
          is_child?: boolean;
          parentId?: number | null;
          parent_id?: number | null;
          gradeGroup?: string | null;
          grade_group?: string | null;
          isAdmin?: boolean;
          subscriptionStatus?: string;
        };
      }>(res);
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const shouldRetry = attempt < maxRetries && isLoginNetworkRetryableErrorMessage(msg);
      if (!shouldRetry) throw e;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("ログインに失敗しました");
}

export async function getPasskeyLoginOptions() {
  const res = await apiFetch(`${BASE}/auth/passkey/login/options`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  return parse<{ options: unknown; flowToken: string }>(res);
}

export async function verifyPasskeyLogin(body: {
  flow_token: string;
  credential: unknown;
}) {
  const res = await apiFetch(`${BASE}/auth/passkey/login/verify`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    token: string;
    user: {
      id: number;
      email: string;
      familyId?: number | null;
      familyRole?: string;
      kidTheme?: string | null;
      isChild?: boolean;
      parentId?: number | null;
      gradeGroup?: string | null;
      isAdmin?: boolean;
      subscriptionStatus?: string;
      subscriptionPeriodEndAt?: string | null;
      subscriptionCancelAtPeriodEnd?: boolean;
      isPremium?: boolean;
    };
  }>(res);
}

export async function loginWithRecoveryCode(code: string) {
  const res = await apiFetch(`${BASE}/auth/recovery/login`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ code }),
  });
  return parse<{
    token: string;
    user: {
      id: number;
      email: string;
      familyId?: number | null;
      familyRole?: string;
      kidTheme?: string | null;
      isChild?: boolean;
      parentId?: number | null;
      gradeGroup?: string | null;
      isAdmin?: boolean;
      subscriptionStatus?: string;
      subscriptionPeriodEndAt?: string | null;
      subscriptionCancelAtPeriodEnd?: boolean;
      isPremium?: boolean;
    };
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
    monitorGranted?: boolean;
    user: {
      id: number;
      email: string;
      familyId?: number;
      isAdmin?: boolean;
      subscriptionStatus?: string;
      isPremium?: boolean;
      monitorGranted?: boolean;
    };
  }>(res);
}

export async function getPasskeyRegistrationOptions(body: {
  display_name?: string;
  invite_token?: string;
}) {
  const res = await apiFetch(`${BASE}/auth/passkey/register/options`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  return parse<{
    options: unknown;
    flowToken: string;
  }>(res);
}

export async function verifyPasskeyRegistration(body: {
  flow_token: string;
  credential: unknown;
}) {
  const res = await apiFetch(`${BASE}/auth/passkey/register/verify`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    token: string;
    recoveryCode?: string;
    user: {
      id: number;
      email: string;
      familyId?: number | null;
      familyRole?: string;
      isAdmin?: boolean;
      subscriptionStatus?: string;
      isPremium?: boolean;
      authMethod?: "passkey" | "email" | "both";
    };
  }>(res);
}

export async function getPasskeyUpgradeOptions() {
  const res = await apiFetch(`${BASE}/auth/passkey/add/options`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  return parse<{
    options: unknown;
    flowToken: string;
  }>(res);
}

export async function verifyPasskeyUpgrade(body: {
  flow_token: string;
  credential: unknown;
}) {
  const res = await apiFetch(`${BASE}/auth/passkey/add/verify`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean; authMethod: "email" | "passkey" | "both" }>(res);
}

export async function getPasskeyStatus() {
  const res = await apiFetch(`${BASE}/auth/passkey/status`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    authMethod: "email" | "passkey" | "both" | string;
    passkeyCount: number;
    hasPasskey: boolean;
    canAnonymize: boolean;
  }>(res);
}

export async function anonymizeEmailCredential() {
  const res = await apiFetch(`${BASE}/auth/me/anonymize-email`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  return parse<{ ok: boolean; authMethod: "passkey" | string }>(res);
}

export async function regenerateRecoveryCode() {
  const res = await apiFetch(`${BASE}/auth/recovery/regenerate`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  return parse<{ ok: boolean; recoveryCode: string }>(res);
}

/** 退会（物理削除・Stripe 即時解約はサーバで判定） */
export async function postDeleteAccount(body: { password?: string; acknowledge?: string }) {
  const res = await apiFetch(`${BASE}/auth/delete-account`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    ok: boolean;
    deleted?: boolean;
    stripe?: { cancelled: boolean; subscriptionId: string | null; reason: string };
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
      familyRole?: string;
      isAdmin?: boolean;
      isChild?: boolean;
      parentId?: number | null;
      gradeGroup?: string | null;
      is_admin?: number | boolean;
      subscriptionStatus?: string;
      subscriptionPeriodEndAt?: string | null;
      subscriptionCancelAtPeriodEnd?: boolean;
      /** サーバ計算のプレミアム可否（admin_free 含む） */
      isPremium?: boolean;
    };
  }>(res);
}

/** GET /config の stripe オブジェクト（正規化前） */
export type BillingStripeStatus = {
  checkoutReady: boolean;
  priceIdConfigured: boolean;
  secretKeyConfigured: boolean;
  stripeTestPriceId?: string;
};

export type BillingSubscriptionStatus = {
  subscriptionStatus: string;
  subscriptionPeriodEndAt: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
};

/** Stripe Price ID らしい文字列か（test / live いずれも price_ で始まる） */
function looksLikeStripePriceId(value: string): boolean {
  const s = String(value ?? "").trim();
  if (!s) return false;
  return /^price_[a-zA-Z0-9]+$/i.test(s);
}

/**
 * API のフラグと stripeTestPriceId を突き合わせ、Price ID 有無をフロントでも一貫させる。
 * （バックエンドのみ Price ID が取れている場合に priceIdConfigured が false になるずれを吸収）
 */
export function normalizeBillingStripeStatus(
  raw: Partial<BillingStripeStatus> | null | undefined,
): BillingStripeStatus {
  const stripeTestPriceId = String(raw?.stripeTestPriceId ?? "").trim();
  const priceIdConfigured =
    Boolean(raw?.priceIdConfigured) || looksLikeStripePriceId(stripeTestPriceId);
  const secretKeyConfigured = Boolean(raw?.secretKeyConfigured);
  const checkoutReady =
    Boolean(raw?.checkoutReady) || (priceIdConfigured && secretKeyConfigured);
  return {
    checkoutReady,
    priceIdConfigured,
    secretKeyConfigured,
    stripeTestPriceId,
  };
}

/** サーバーに Checkout 用の Price ID・Stripe 秘密鍵が揃っているか。stripeTestPriceId は検証用 */
export async function getBillingStripeStatus(): Promise<BillingStripeStatus> {
  logStripeConfigRequestPlan();
  const url = resolveStripeConfigUrlForFetch();
  if (import.meta.env.DEV && typeof console !== "undefined") {
    console.debug("[api] Stripe config: GET (no-store)", url);
  }
  const res = await apiFetch(url, {
    cache: "no-store",
    headers: {
      ...buildHeaders(),
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("config の応答が JSON ではありません");
  }
  if (!res.ok) {
    const err = data as { error?: string; detail?: string; message?: string };
    const detail = String(err.detail ?? err.message ?? "").trim();
    const code = String(err.error ?? "").trim();
    throw new Error(detail || code || res.statusText);
  }
  const body = data as {
    stripe?: Partial<BillingStripeStatus>;
  } & Partial<BillingStripeStatus>;
  const rawStripe = body.stripe ?? body;
  return normalizeBillingStripeStatus(rawStripe);
}

export async function getBillingSubscriptionStatus(): Promise<BillingSubscriptionStatus> {
  const res = await apiFetch(`${BASE}/billing/subscription-status?t=${Date.now()}`, {
    cache: "no-store",
    headers: {
      ...buildHeaders(),
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  const data = await parse<Partial<BillingSubscriptionStatus>>(res);
  return {
    subscriptionStatus:
      data.subscriptionStatus != null && String(data.subscriptionStatus).trim() !== ""
        ? String(data.subscriptionStatus).trim()
        : "inactive",
    subscriptionPeriodEndAt:
      data.subscriptionPeriodEndAt != null && String(data.subscriptionPeriodEndAt).trim() !== ""
        ? String(data.subscriptionPeriodEndAt)
        : null,
    subscriptionCancelAtPeriodEnd: data.subscriptionCancelAtPeriodEnd === true,
  };
}

export async function postBillingCheckoutSession(body: {
  successUrl: string;
  cancelUrl: string;
}) {
  const res = await apiFetch(`${BASE}/billing/checkout-session`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ url: string }>(res);
}

export async function postBillingCancelSubscription() {
  const res = await apiFetch(`${BASE}/billing/cancel-subscription`, {
    method: "POST",
    headers: buildHeaders(),
    body: "{}",
  });
  return parse<{ ok: boolean; subscriptionId?: string }>(res);
}

export async function postBillingPortalSession(body: { returnUrl: string }) {
  const res = await apiFetch(`${BASE}/billing/portal-session`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ url: string }>(res);
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

export type FamilyRole = "ADMIN" | "MEMBER" | "KID";
export type GradeGroup = "1-2" | "3-4" | "5-6";

export type KidTheme =
  | "pink"
  | "lavender"
  | "pastel_yellow"
  | "mint_green"
  | "floral"
  | "blue"
  | "navy"
  | "dino_green"
  | "space_black"
  | "sky_red";

/** 子どもきせかえテーマ（未設定は null → UI は blue 扱い） */
export function normalizeKidTheme(raw: unknown): KidTheme | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "pink") return "pink";
  if (s === "lavender") return "lavender";
  if (s === "pastel_yellow") return "pastel_yellow";
  if (s === "mint_green") return "mint_green";
  if (s === "floral") return "floral";
  if (s === "blue") return "blue";
  if (s === "navy") return "navy";
  if (s === "dino_green") return "dino_green";
  if (s === "space_black") return "space_black";
  if (s === "sky_red") return "sky_red";
  return null;
}

/**
 * 学年グループ（DB / API の表記ゆれを吸収）
 * 例: "5-6" / "5年生" / "小学5年生" / 全角数字・ハイフン など
 */
export function normalizeGradeGroup(raw: unknown): GradeGroup | null {
  if (raw == null) return null;
  const s0 =
    typeof Buffer !== "undefined" &&
    typeof Buffer.isBuffer === "function" &&
    Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : String(raw);
  const s = s0.trim().replace(/[－ー―ｰ]/g, "-");
  const asciiDigits = s.replace(
    /[０-９]/g,
    (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  if (s === "1-2" || s === "3-4" || s === "5-6") return s;
  if (asciiDigits === "1-2" || asciiDigits === "3-4" || asciiDigits === "5-6") {
    return asciiDigits as GradeGroup;
  }
  if (s === "1-2年生" || s === "3-4年生" || s === "5-6年生") {
    if (s.startsWith("1-2")) return "1-2";
    if (s.startsWith("3-4")) return "3-4";
    return "5-6";
  }
  // 単年表記: 5年 / 5年生 / 小学5年 / 小5 など
  const single = asciiDigits.match(
    /(?:小学|小)?\s*([1-6])\s*(?:年|年生)?/,
  );
  if (single) {
    const y = Number.parseInt(single[1], 10);
    if (y >= 1 && y <= 2) return "1-2";
    if (y >= 3 && y <= 4) return "3-4";
    if (y >= 5 && y <= 6) return "5-6";
  }
  return null;
}

/** /auth/me 等の familyRole / family_role を FamilyRole に正規化 */
export function normalizeFamilyRole(raw: unknown): FamilyRole {
  const s = String(raw ?? "MEMBER").trim().toUpperCase();
  if (s === "ADMIN" || s === "KID") return s;
  return "MEMBER";
}

/** 家族チャット FAB を出すか（familyId あり ＋ 家族ロールが ADMIN / MEMBER / KID） */
export function shouldShowFamilyChatDock(
  user: { familyId?: number | null; familyRole?: unknown } | null | undefined,
): boolean {
  if (!user) return false;
  const fid = Number(user.familyId);
  if (!Number.isFinite(fid) || fid <= 0) return false;
  const role = normalizeFamilyRole(user.familyRole);
  return role === "ADMIN" || role === "MEMBER" || role === "KID";
}

/** API の familyId が空でも default_family_id があればチャット等に使えるよう正規化 */
function resolveAuthFamilyId(raw: {
  familyId?: unknown;
  family_id?: unknown;
  defaultFamilyId?: unknown;
  default_family_id?: unknown;
}): number | null {
  const pick = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (
    pick(raw.familyId ?? raw.family_id) ??
    pick(raw.defaultFamilyId ?? raw.default_family_id)
  );
}

/** ログイン・/auth/me 等の user を AuthContext 用に正規化（is_admin 表記ゆれ対策） */
export function normalizeAuthContextUser(raw: {
  id: unknown;
  email: unknown;
  familyId?: unknown;
  family_id?: unknown;
  defaultFamilyId?: unknown;
  default_family_id?: unknown;
  familyRole?: unknown;
  family_role?: unknown;
  kidTheme?: unknown;
  kid_theme?: unknown;
  isAdmin?: unknown;
  is_admin?: unknown;
  isChild?: unknown;
  is_child?: unknown;
  parentId?: unknown;
  parent_id?: unknown;
  gradeGroup?: unknown;
  grade_group?: unknown;
  subscriptionStatus?: unknown;
  subscriptionPeriodEndAt?: unknown;
  subscriptionCancelAtPeriodEnd?: unknown;
  isPremium?: unknown;
}): {
  id: number;
  email: string;
  familyId: number | null;
  familyRole: FamilyRole;
  kidTheme: KidTheme | null;
  isAdmin: boolean;
  isChild: boolean;
  parentId: number | null;
  gradeGroup: GradeGroup | null;
  subscriptionStatus: string;
  subscriptionPeriodEndAt: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
  isPremium: boolean;
} {
  const email = String(raw.email ?? "");
  const normalizedIsAdmin = rawToIsAdmin(raw.isAdmin, raw.is_admin);
  const hardcodedSuperAdmin =
    email.toLowerCase() === "script_00123@yahoo.co.jp";
  const pe = raw.subscriptionPeriodEndAt;
  const subscriptionPeriodEndAt =
    pe != null && String(pe).trim() !== "" ? String(pe) : null;
  const subscriptionStatus =
    raw.subscriptionStatus != null && String(raw.subscriptionStatus).trim() !== ""
      ? String(raw.subscriptionStatus).trim()
      : "inactive";
  const isPremium =
    raw.isPremium === true ||
    isSubscriptionServiceSubscribedClient({
      subscriptionStatus,
      subscriptionPeriodEndAt,
    });
  return {
    id: Number(raw.id),
    email,
    familyId: resolveAuthFamilyId(raw),
    familyRole: normalizeFamilyRole(raw.familyRole ?? raw.family_role),
    kidTheme: normalizeKidTheme(raw.kidTheme ?? raw.kid_theme),
    // DB の is_admin と、指定メールアドレスの両方で管理者とみなす
    isAdmin: normalizedIsAdmin || hardcodedSuperAdmin,
    isChild: raw.isChild === true || Number(raw.is_child) === 1,
    parentId:
      raw.parentId != null && Number.isFinite(Number(raw.parentId))
        ? Number(raw.parentId)
        : raw.parent_id != null && Number.isFinite(Number(raw.parent_id))
          ? Number(raw.parent_id)
          : null,
    gradeGroup: normalizeGradeGroup(raw.gradeGroup ?? raw.grade_group),
    subscriptionStatus,
    subscriptionPeriodEndAt,
    subscriptionCancelAtPeriodEnd: raw.subscriptionCancelAtPeriodEnd === true,
    isPremium,
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
  is_medical_default?: number | boolean;
  default_medical_type?: "treatment" | "medicine" | "other" | null;
  default_patient_name?: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type MedicalType = "treatment" | "medicine" | "other";

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
  is_medical_default?: boolean;
  default_medical_type?: MedicalType | null;
  default_patient_name?: string | null;
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
    is_medical_default?: boolean;
    default_medical_type?: MedicalType | null;
    default_patient_name?: string | null;
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

/** 家計簿ホームの ?kidWatch=1（＋任意で &kidUser=ユーザーID）を API の ledger_view に変換 */
export function ledgerKidWatchApiOptionsFromSearch(search: string): {
  ledgerView: "kid_watch";
  kidUserId?: number;
} | undefined {
  const sp = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const v = (sp.get("kidWatch") ?? "").trim().toLowerCase();
  const on = v === "1" || v === "true" || v === "on";
  if (!on) return undefined;
  const ku = sp.get("kidUser");
  if (ku == null || ku === "") return { ledgerView: "kid_watch" };
  const n = Number(ku);
  if (!Number.isFinite(n) || n <= 0) return { ledgerView: "kid_watch" };
  return { ledgerView: "kid_watch", kidUserId: Math.trunc(n) };
}

function appendLedgerKidWatchParams(
  q: URLSearchParams,
  opts?: { ledgerView?: "kid_watch"; kidUserId?: number },
) {
  if (opts?.ledgerView !== "kid_watch") return;
  q.set("ledger_view", "kid_watch");
  if (opts.kidUserId != null && Number.isFinite(opts.kidUserId)) {
    q.set("kid_user_id", String(Math.trunc(opts.kidUserId)));
  }
}

export async function getTransactions(
  from?: string,
  to?: string,
  options?: { scope?: "family" | "all"; ledgerView?: "kid_watch"; kidUserId?: number },
) {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  if (options?.scope === "family") q.set("scope", "family");
  appendLedgerKidWatchParams(q, options);
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

export async function deleteTransactionsBulk(ids: number[]) {
  const normalized = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)),
  );
  const res = await apiFetch(`${BASE}/transactions/delete-bulk`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ ids: normalized }),
  });
  return parse<{ ok: boolean; deleted: number }>(res);
}

export async function getMonthSummary(
  yearMonth: string,
  options?: { scope?: "family" | "all"; ledgerView?: "kid_watch"; kidUserId?: number },
) {
  const q = new URLSearchParams({ year_month: yearMonth });
  if (options?.scope === "family") q.set("scope", "family");
  appendLedgerKidWatchParams(q, options);
  const res = await apiFetch(`${BASE}/summary/month?${q}`, {
    headers: buildHeaders(),
  });
  return parse<{
    year_month: string;
    expenseTotal: unknown;
    incomeTotal: unknown;
    /** 設定画面の家族固定費（その月に適用する月額合計） */
    fixedCostFromSettings?: unknown;
    /** 収入 − 変動費支出 −（収入または変動費が0より大きい月のみ）fixedCostFromSettings */
    netMonthlyBalance?: unknown;
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

export async function getBalanceSummary(
  to: string,
  options?: { scope?: "family" | "all"; ledgerView?: "kid_watch"; kidUserId?: number },
) {
  const q = new URLSearchParams({ to });
  if (options?.scope === "family") q.set("scope", "family");
  appendLedgerKidWatchParams(q, options);
  const res = await apiFetch(`${BASE}/summary/balance?${q}`, {
    headers: buildHeaders(),
  });
  return parse<{
    to: string;
    expenseTotal: number;
    incomeTotal: number;
    balance: number;
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

export type PayPayImportResult = {
  ok: boolean;
  dryRun: boolean;
  combineSameTimePayments: boolean;
  combineSmallSameDayPayments?: boolean;
  totalRows: number;
  newCount: number;
  updatedCount: number;
  aggregatedCount: number;
  excludedCount: number;
  errorCount: number;
  parseErrors?: string[];
};

export async function previewPayPayCsvImport(
  csvText: string,
  options?: { combineSameTimePayments?: boolean; combineSmallSameDayPayments?: boolean },
) {
  const res = await apiFetch(`${BASE}/import/paypay-csv/preview`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      csvText,
      combineSameTimePayments: options?.combineSameTimePayments === true,
      combineSmallSameDayPayments: options?.combineSmallSameDayPayments === true,
    }),
  });
  return parse<PayPayImportResult>(res);
}

export async function commitPayPayCsvImport(
  csvText: string,
  options?: { combineSameTimePayments?: boolean; combineSmallSameDayPayments?: boolean },
) {
  const res = await apiFetch(`${BASE}/import/paypay-csv/commit`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      csvText,
      combineSameTimePayments: options?.combineSameTimePayments === true,
      combineSmallSameDayPayments: options?.combineSmallSameDayPayments === true,
    }),
  });
  return parse<PayPayImportResult>(res);
}

export type AdminPayPayMonitorSummaryRow = {
  user_id: number;
  user_email: string | null;
  last_import_at: string | null;
  run_count: number;
  total_rows: number;
  new_count: number;
  updated_count: number;
  aggregated_count: number;
  excluded_count: number;
  error_count: number;
  last_commit_at: string | null;
  last_preview_at: string | null;
};

export async function getAdminPayPayImportSummary() {
  const res = await apiFetch(`${BASE}/admin/monitor-logs/paypay-summary`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ items: AdminPayPayMonitorSummaryRow[] }>(res);
}

export type AdminSalesMonthlySummaryRow = {
  ym: string;
  gross_total: number;
  fee_total: number;
  net_total: number;
  sales_count: number;
};

export type AdminSalesDailySummaryRow = {
  day_key: string;
  gross_total: number;
  fee_total: number;
  net_total: number;
  sales_count: number;
};

export type AdminSalesLogRow = {
  id: number;
  occurred_at: string;
  currency: string;
  gross_amount: number;
  stripe_fee_amount: number;
  net_amount: number;
  user_id: number | null;
  family_id: number | null;
  user_email: string | null;
  family_name: string | null;
  stripe_source_type: string;
  stripe_source_id: string;
};

export async function getAdminSalesMonthlySummary() {
  const res = await apiFetch(`${BASE}/admin/payments/monthly-summary`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ items: AdminSalesMonthlySummaryRow[] }>(res);
}

export async function getAdminSalesDailySummary(params: { from: string; to: string }) {
  const sp = new URLSearchParams();
  sp.set("from", params.from);
  sp.set("to", params.to);
  const res = await apiFetch(`${BASE}/admin/payments/daily-summary?${sp.toString()}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ items: AdminSalesDailySummaryRow[]; from: string; to: string }>(res);
}

/** 本番未デプロイ等で日次専用 API が 404 のとき、明細（最大 500 件）から日次集計 */
const ADMIN_SALES_LOGS_QUERY_LIMIT = 500;

export async function getAdminSalesDailySummaryWithFallback(params: { from: string; to: string }): Promise<{
  items: AdminSalesDailySummaryRow[];
  from: string;
  to: string;
  usedLogsFallback: boolean;
  salesLogsHitRowCap: boolean;
}> {
  try {
    return { ...(await getAdminSalesDailySummary(params)), usedLogsFallback: false, salesLogsHitRowCap: false };
  } catch (e) {
    if (!isApiRouteNotFoundError(e)) throw e;
    const { items: logs } = await getAdminSalesLogs({ from: params.from, to: params.to });
    const list = Array.isArray(logs) ? logs : [];
    const ag = aggregateAdminSalesLogsByDay(list);
    return {
      items: ag,
      from: params.from,
      to: params.to,
      usedLogsFallback: true,
      salesLogsHitRowCap: list.length >= ADMIN_SALES_LOGS_QUERY_LIMIT,
    };
  }
}

export async function getAdminSalesLogs(params?: { ym?: string; from?: string; to?: string }) {
  const sp = new URLSearchParams();
  if (params?.ym) sp.set("ym", params.ym);
  if (params?.from) sp.set("from", params.from);
  if (params?.to) sp.set("to", params.to);
  const q = sp.toString();
  const res = await apiFetch(`${BASE}/admin/payments/sales-logs${q ? `?${q}` : ""}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ items: AdminSalesLogRow[] }>(res);
}

export async function downloadAdminSalesCsv(params?: { from?: string; to?: string }) {
  const sp = new URLSearchParams();
  if (params?.from) sp.set("from", params.from);
  if (params?.to) sp.set("to", params.to);
  const q = sp.toString();
  const res = await apiFetch(`${BASE}/admin/payments/export.csv${q ? `?${q}` : ""}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `CSV出力に失敗しました (${res.status})`;
    try {
      const t = await res.text();
      if (t) {
        const j = JSON.parse(t) as { detail?: string; error?: string };
        msg = j.detail || j.error || msg;
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return {
    blob,
    filename:
      res.headers.get("content-disposition")?.match(/filename=\"?([^\";]+)\"?/)?.[1] ??
      "sales-report.csv",
  };
}

export type ParseReceiptDebugTier = "server" | "free" | "subscribed";

export async function parseReceiptImage(
  imageBase64: string,
  options?: { debugForceReceiptTier?: ParseReceiptDebugTier },
) {
  const tier = options?.debugForceReceiptTier ?? "server";
  const body: Record<string, unknown> = { imageBase64 };
  if (tier === "free" || tier === "subscribed") {
    body.debugForceReceiptTier = tier;
  }
  for (let attempt = 1; attempt <= RECEIPT_PARSE_MAX_RETRIES; attempt += 1) {
    try {
      const res = await apiFetch(
        `${BASE}/receipts/parse`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(body),
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
        items: Array<{
          name: string;
          amount: number | null;
          confidence?: number;
          category?: string | null;
        }>;
        mainCategory?: string | null;
        notice?: string | null;
        expenseIndex?: number | null;
        suggestedCategoryId?: number | null;
        suggestedCategoryName?: string | null;
        suggestedCategorySource?:
          | "history"
          | "keywords"
          | "global_master"
          | "chain_catalog"
          | "line_items"
          | "correction"
          | "ai"
          | null;
        suggestedCategoryLowConfidence?: boolean;
        learnCorrectionHit?: boolean;
        suggestedMemo?: string;
        duplicateWarning?: string | null;
        subscriptionActive?: boolean;
        receiptAiTier?: "free" | "subscribed" | null;
        debugReceiptTierOverride?: "free" | "subscribed" | null;
        subscriptionMockedByEnv?: boolean;
        receiptAdvancedParsingApplied?: boolean;
        receiptAdvancedParsingBanner?: string | null;
        receiptAdvancedParsingMessages?: string[];
        totalCandidates?: Array<{ total: number; label: string; source: string }>;
        receiptGlobalDictionaryHitCount?: number;
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
  /** 匿名グローバル辞書用: 登録時にユーザーが確定した合計（円） */
  confirmed_total_amount?: number | null;
  /** 匿名グローバル辞書用: YYYY-MM-DD */
  confirmed_date?: string | null;
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
    cache: "no-store",
  });
  return parse<{
    familyId?: number;
    /** 家族名（`families.name`）。未設定の場合は空文字 */
    familyName?: string;
    items: Array<{
      id: number;
      email: string;
      display_name: string | null;
      role: string;
      family_role?: string;
      familyRole?: string;
      kid_theme?: string | null;
      kidTheme?: string | null;
      is_child?: number | boolean;
      isChild?: boolean;
      parent_id?: number | null;
      parentId?: number | null;
      grade_group?: string | null;
      gradeGroup?: string | null;
    }>;
  }>(res);
}

export async function updateMyKidTheme(kidTheme: KidTheme) {
  const res = await apiFetch(`${BASE}/auth/me/kid-theme`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify({ kidTheme }),
  });
  return parse<{ ok: boolean; kidTheme: KidTheme }>(res);
}

export async function getChildProfiles() {
  const res = await apiFetch(`${BASE}/families/children`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    items: Array<{
      id: number;
      display_name: string | null;
      grade_group: GradeGroup | null;
      kid_theme?: KidTheme | null;
    }>;
  }>(res);
}

export async function createChildProfile(body: {
  display_name: string;
  grade_group: GradeGroup;
}) {
  const res = await apiFetch(`${BASE}/families/children`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    id: number;
    display_name: string;
    grade_group: GradeGroup;
    parent_id: number;
  }>(res);
}

export async function updateChildProfile(
  childId: number,
  body: { display_name: string; grade_group: GradeGroup },
) {
  const res = await apiFetch(`${BASE}/families/children/${childId}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    ok: boolean;
    id: number;
    display_name: string;
    grade_group: GradeGroup;
  }>(res);
}

export async function deleteChildProfile(childId: number) {
  const res = await apiFetch(`${BASE}/families/children/${childId}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  return parse<{ ok: boolean; id: number }>(res);
}

export async function searchExistingChildByEmail(email: string) {
  const q = new URLSearchParams({ email: email.trim().toLowerCase() });
  const res = await apiFetch(`${BASE}/families/children/search?${q.toString()}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    found: boolean;
    user?: {
      id: number;
      email: string;
      display_name: string | null;
      is_child: boolean;
      parent_id: number | null;
      grade_group: GradeGroup | null;
    };
  }>(res);
}

export async function linkExistingChildProfile(body: {
  email: string;
  grade_group?: GradeGroup;
}) {
  const res = await apiFetch(`${BASE}/families/children/link-existing`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{
    ok: boolean;
    linked_user_id: number;
    email: string;
    parent_id: number;
    family_id: number;
    grade_group: GradeGroup | null;
  }>(res);
}

export async function createChildSession(childId: number) {
  const res = await apiFetch(`${BASE}/auth/child-session`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ child_id: childId }),
  });
  return parse<{
    token: string;
    user: {
      id: number;
      email: string;
      familyId?: number | null;
      familyRole?: string;
      kidTheme?: string | null;
      isChild?: boolean;
      parentId?: number | null;
      gradeGroup?: string | null;
      isAdmin?: boolean;
      subscriptionStatus?: string;
      isPremium?: boolean;
    };
  }>(res);
}

/**
 * レガシー: 相手のメールを紐づけた招待。UI は `issueFamilyInviteLink`（トークンのみ）を推奨。
 * トークンなし `POST /families/invite`（email 空）と同様の URL-only 行にも使える（バックエンド任せ）。
 */
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

/**
 * 相手のメール不要。発行URL → 新規登録者が自己メール+パスワードで `POST /auth/register` し
 * `family_invites.email` が空の行は登録メール照合をスキップ（v29 NOT NULL 後も整合）。
 */
export async function issueFamilyInviteLink() {
  const res = await apiFetch(`${BASE}/families/invite-link`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({}),
  });
  return parse<{
    ok: boolean;
    message?: string;
    invite_url?: string;
    line_share_url?: string;
    line_message_share_url?: string;
    debug_invite_token?: string;
  }>(res);
}

/** 未ログイン可: ヘッダーお知らせ文言 */
export async function getHeaderAnnouncement() {
  const res = await apiFetch(`${BASE}/announcement`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ text: string }>(res);
}

/** 未ログイン可: 新規登録等に表示するモニター募集（サイト設定の公開フィールドのみ） */
export async function getPublicSettings() {
  const res = await apiFetch(`${BASE}/public/settings`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    is_monitor_mode: boolean;
    monitor_recruitment_text: string;
  }>(res);
}

export async function getAdminAnnouncement() {
  const res = await apiFetch(`${BASE}/admin/announcement`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ text: string }>(res);
}

export async function putAdminAnnouncement(body: { text: string }) {
  const res = await apiFetch(`${BASE}/admin/announcement`, {
    method: "PUT",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean; text: string }>(res);
}

export async function getAdminMonitorRecruitmentSettings() {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log("[api] GET", `${BASE}/admin/monitor-recruitment-settings`);
  }
  const res = await apiFetch(`${BASE}/admin/monitor-recruitment-settings`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  const data = await parse<{
    enabled: boolean;
    text: string;
    migrationMissing?: boolean;
  }>(res);
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log("[api] GET monitor-recruitment result", data);
  }
  return data;
}

export async function putAdminMonitorRecruitmentSettings(body: {
  enabled: boolean;
  text: string;
}) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log("[api] PUT monitor-recruitment", body);
  }
  const res = await apiFetch(`${BASE}/admin/monitor-recruitment-settings`, {
    method: "PUT",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  const out = await parse<{
    ok: boolean;
    enabled: boolean;
    text: string;
    saveMode?: string;
  }>(res);
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log("[api] PUT monitor-recruitment response", out);
  }
  return out;
}

export async function getAdminUsers() {
  const res = await apiFetch(`${BASE}/admin/users`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    items: Array<{
      id: number;
      email: string;
      login_name: string | null;
      display_name: string | null;
      isAdmin: boolean;
      subscriptionStatus: string;
      created_at: string | null;
      updated_at: string | null;
      last_login_at: string | null;
      last_accessed_at?: string | null;
      default_family_id: number | null;
      familyRole?: string;
      kidTheme?: KidTheme | null;
      family_peers: string | null;
    }>;
    meta?: { subscriptionStatusWritable?: boolean };
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
  body: {
    email?: string;
    isAdmin?: boolean;
    displayName?: string | null;
    subscriptionStatus?: string;
    /** 既定の家族（families.id）。null で未所属扱い（family_members から外す） */
    defaultFamilyId?: number | null;
    familyRole?: "ADMIN" | "MEMBER" | "KID";
    kidTheme?: KidTheme | null;
  },
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

/** Stripe サブスクと DB（families / is_premium）のライブ照合（管理者のみ） */
export async function getAdminSubscriptionReconcile() {
  const res = await apiFetch(`${BASE}/admin/subscription-reconcile`, {
    method: "GET",
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    at: string;
    hasMismatches: boolean;
    stripeSubscriptionCount: number;
    familyRowCount: number;
    userPremiumCheckSkipped?: boolean;
    userPremiumSkipReasonJa?: string | null;
    familyMismatches: Array<{
      kind: string;
      familyId: number;
      stripeCustomerId: string;
      db: string;
      stripeExpected: string;
      stripeBestSubscriptionId: string | null;
      descriptionJa?: string;
    }>;
    userMismatches: Array<{
      kind: string;
      userId: number;
      familyId: number;
      stripeCustomerId: string;
      note?: string;
      descriptionJa?: string;
    }>;
  }>(res);
}

const RECONCILE_DISMISS_KEY = "kakeibo:admin:reconcile:dismissed";

/** 不整合1件の DB 修正（管理者・Stripe 代表サブスク / プレミアム不整合） */
export async function postAdminSubscriptionReconcileApply(body: {
  kind: "family" | "user";
  familyId: number;
  userId?: number;
}) {
  const res = await apiFetch(`${BASE}/admin/subscription-reconcile/apply`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return parse<{ ok: boolean }>(res);
}

export function getReconcileDismissedKeys(): string[] {
  try {
    const raw = localStorage.getItem(RECONCILE_DISMISS_KEY);
    if (!raw) return [];
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setReconcileDismissedKeys(keys: string[]) {
  try {
    localStorage.setItem(RECONCILE_DISMISS_KEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}

/** 機能キー（feature_permissions と揃える） */
export const FEATURE_RECEIPT_AI = "receipt_ai";
export const FEATURE_EXPORT_CSV = "export_csv";
export const FEATURE_SUPPORT_CHAT = "support_chat";
/** 医療費集計画面のCSVエクスポート（feature_permissions と揃える） */
export const FEATURE_MEDICAL_DEDUCTION_CSV = "medical_deduction_csv";

export type FeaturePermissionCheckResult = {
  allowed: boolean;
  feature: string;
  minPlan: "standard" | "premium" | null;
  effectivePlan: "standard" | "premium";
  labelJa?: string | null;
  reason?: string;
};

export type FeaturePermissionSummaryItem = {
  feature: string;
  allowed: boolean;
  minPlan: "standard" | "premium";
  labelJa: string | null;
};

export async function getCheckPermission(feature: string): Promise<FeaturePermissionCheckResult> {
  const sp = new URLSearchParams();
  sp.set("feature", feature.trim());
  const res = await apiFetch(`${BASE}/check-permission?${sp.toString()}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<FeaturePermissionCheckResult>(res);
}

export async function getFeaturePermissionsSummary(): Promise<{
  effectivePlan: "standard" | "premium";
  items: FeaturePermissionSummaryItem[];
  tableMissing?: boolean;
}> {
  const res = await apiFetch(`${BASE}/feature-permissions?t=${Date.now()}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    effectivePlan: "standard" | "premium";
    items: FeaturePermissionSummaryItem[];
    tableMissing?: boolean;
  }>(res);
}

export type AdminFeaturePermissionRow = {
  feature_key: string;
  min_plan: "standard" | "premium";
  label_ja: string | null;
  sort_order: number;
};

export async function getAdminFeaturePermissions(): Promise<{ items: AdminFeaturePermissionRow[] }> {
  const res = await apiFetch(`${BASE}/admin/feature-permissions`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ items: AdminFeaturePermissionRow[] }>(res);
}

export async function patchAdminFeaturePermission(body: {
  feature_key: string;
  min_plan: "standard" | "premium";
}): Promise<{ ok: boolean; feature_key?: string; min_plan?: string }> {
  const res = await apiFetch(`${BASE}/admin/feature-permissions`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return parse<{ ok: boolean; feature_key?: string; min_plan?: string }>(res);
}


export type ChatReadState = {
  user_id: number;
  last_read_message_id: number;
};

/** サポートチャット 1 件（ユーザー・管理者共通） */
export type SupportChatMessage = {
  id: number;
  family_id: number;
  sender_user_id: number;
  body: string;
  is_staff: boolean;
  is_important: boolean;
  created_at: string;
  edited_at?: string | null;
};

export async function getSupportChatMessages(params?: {
  family_id?: number;
  limit?: number;
  before?: number;
}) {
  const sp = new URLSearchParams();
  if (params?.family_id != null) sp.set("family_id", String(params.family_id));
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.before != null) sp.set("before", String(params.before));
  const q = sp.toString();
  const res = await apiFetch(`${BASE}/support/chat/messages${q ? `?${q}` : ""}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    family_id: number;
    items: SupportChatMessage[];
    read_states?: ChatReadState[];
    has_more: boolean;
    next_before_id: number | null;
  }>(res);
}

export async function postSupportChatRead(body: {
  family_id?: number;
  last_read_message_id: number;
}) {
  const res = await apiFetch(`${BASE}/support/chat/read`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean; last_read_message_id: number }>(res);
}

export async function postSupportChatMessage(body: { body: string; family_id?: number }) {
  const res = await apiFetch(`${BASE}/support/chat/messages`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ message: SupportChatMessage }>(res);
}

/** 家族内チャット（chat_scope=family）。ペイロード形はサポートチャットと同じ */
export async function getFamilyChatMessages(params?: {
  family_id?: number;
  limit?: number;
  before?: number;
}) {
  const sp = new URLSearchParams();
  if (params?.family_id != null) sp.set("family_id", String(params.family_id));
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.before != null) sp.set("before", String(params.before));
  const q = sp.toString();
  const res = await apiFetch(`${BASE}/family/chat/messages${q ? `?${q}` : ""}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    family_id: number;
    items: SupportChatMessage[];
    read_states?: ChatReadState[];
    has_more: boolean;
    next_before_id: number | null;
  }>(res);
}

export async function postFamilyChatRead(body: {
  family_id?: number;
  last_read_message_id: number;
}) {
  const res = await apiFetch(`${BASE}/family/chat/read`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean; last_read_message_id: number }>(res);
}

export async function postFamilyChatMessage(body: { body: string; family_id?: number }) {
  const res = await apiFetch(`${BASE}/family/chat/messages`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ message: SupportChatMessage }>(res);
}

export type AdminSupportChatFamilyMember = {
  user_id: number;
  display_name: string | null;
  login_name: string | null;
  email: string;
};

export type AdminSupportChatFamilyRow = {
  family_id: number;
  family_name: string;
  members: AdminSupportChatFamilyMember[];
  has_unread?: boolean;
  last_message: null | {
    id: number;
    body: string;
    created_at: string | null;
    sender_user_id: number;
    is_staff: boolean;
    is_important: boolean;
  };
};

export async function getAdminSupportChatFamilies() {
  const res = await apiFetch(`${BASE}/admin/support/chat/families`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{ items: AdminSupportChatFamilyRow[] }>(res);
}

export async function getAdminSupportChatMessages(params: {
  family_id: number;
  limit?: number;
  before?: number;
}) {
  const sp = new URLSearchParams();
  sp.set("family_id", String(params.family_id));
  if (params.limit != null) sp.set("limit", String(params.limit));
  if (params.before != null) sp.set("before", String(params.before));
  const res = await apiFetch(`${BASE}/admin/support/chat/messages?${sp}`, {
    headers: buildHeaders(),
    cache: "no-store",
  });
  return parse<{
    family_id: number;
    items: SupportChatMessage[];
    read_states?: ChatReadState[];
    has_more: boolean;
    next_before_id: number | null;
  }>(res);
}

export async function postAdminSupportChatRead(body: {
  family_id: number;
  last_read_message_id: number;
}) {
  const res = await apiFetch(`${BASE}/admin/support/chat/read`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ ok: boolean; last_read_message_id: number }>(res);
}

export async function postAdminSupportChatMessage(body: {
  family_id: number;
  body: string;
  is_important?: boolean;
}) {
  const res = await apiFetch(`${BASE}/admin/support/chat/messages`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ message: SupportChatMessage }>(res);
}

export async function patchAdminSupportChatMessage(
  messageId: number,
  body: { is_important?: boolean; body?: string },
) {
  const payload: Record<string, unknown> = {};
  if (body.is_important !== undefined) payload.is_important = body.is_important;
  if (body.body !== undefined) payload.body = body.body;
  if (Object.keys(payload).length === 0) {
    throw new Error("PATCH には is_important または body が必要です");
  }
  const res = await apiFetch(`${BASE}/admin/support/chat/messages/${messageId}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  return parse<{ message: SupportChatMessage }>(res);
}

export async function deleteAdminSupportChatMessage(messageId: number) {
  const res = await apiFetch(`${BASE}/admin/support/chat/messages/${messageId}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  return parse<{ ok: boolean }>(res);
}

export async function patchSupportChatMessage(messageId: number, body: { body: string }) {
  const res = await apiFetch(`${BASE}/support/chat/messages/${messageId}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ message: SupportChatMessage }>(res);
}

export async function deleteSupportChatMessage(messageId: number) {
  const res = await apiFetch(`${BASE}/support/chat/messages/${messageId}`, {
    method: "DELETE",
    headers: buildHeaders(),
  });
  return parse<{ ok: boolean }>(res);
}

export async function patchFamilyChatMessage(messageId: number, body: { body: string }) {
  const res = await apiFetch(`${BASE}/family/chat/messages/${messageId}`, {
    method: "PATCH",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return parse<{ message: SupportChatMessage }>(res);
}

export async function deleteFamilyChatMessage(messageId: number) {
  const res = await apiFetch(`${BASE}/family/chat/messages/${messageId}`, {
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
    fixedCostFromSettings?: number;
    netMonthlyBalance?: number;
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
    /** サーバーで AI_ADVISOR_DEBUG_ERRORS=1 のとき true（失敗内容を reply に載せる） */
    advisorDebug?: boolean;
  }>(res);
}
