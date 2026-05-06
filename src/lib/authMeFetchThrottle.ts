/**
 * GET /auth/me の短時間内の重複取得を抑える（セッションストレージ + メモリ）。
 * ログアウト時は clearAuthMeFetchThrottle を呼ぶこと。
 */

const CACHE_KEY = "kakeibo_auth_me_fetch_v1";

/** 既定 30 秒（ページ遷移で連発しない程度）。Checkout 直後は getAuthMe({ force: true }) を使う */
export const AUTH_ME_MIN_INTERVAL_MS = 30_000;

type CacheEntry = { fp: string; at: number; payload: unknown };

let memory: CacheEntry | null = null;

function safeParse(raw: string): CacheEntry | null {
  try {
    const o = JSON.parse(raw) as CacheEntry;
    if (
      o &&
      typeof o.fp === "string" &&
      typeof o.at === "number" &&
      Object.prototype.hasOwnProperty.call(o, "payload")
    ) {
      return o;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** トークンが変わったときキャッシュが無効になるよう短いフィンガープリント */
export function fingerprintAuthToken(token: string | null): string {
  if (!token || typeof token !== "string") return "";
  const t = token.trim();
  if (!t) return "";
  return t.length > 48 ? t.slice(0, 48) : t;
}

export function clearAuthMeFetchThrottle(): void {
  memory = null;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(CACHE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function readThrottledAuthMe(
  tokenFp: string,
  nowMs: number,
  minIntervalMs: number,
): unknown | null {
  if (!tokenFp) return null;
  if (
    memory &&
    memory.fp === tokenFp &&
    nowMs - memory.at < minIntervalMs
  ) {
    return memory.payload;
  }
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const o = safeParse(raw);
    if (
      o &&
      o.fp === tokenFp &&
      nowMs - o.at < minIntervalMs
    ) {
      memory = o;
      return o.payload;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function writeThrottledAuthMe(
  tokenFp: string,
  payload: unknown,
  nowMs: number,
): void {
  if (!tokenFp) return;
  memory = { fp: tokenFp, at: nowMs, payload };
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(memory));
    }
  } catch {
    /* ignore */
  }
}
