import { getApiBaseUrl } from "./api";

/**
 * ランディング/ログイン用（GET /user-stats）。
 */
export type PublicUserStats = {
  /** `users` 行の総数（会員 / profiles 相当の単一テーブル） */
  registeredUserCount: number;
  /** 直近5分に `last_accessed_at` がある人数（v33 以降。欠落時 null） */
  onlineUserCount5m: number | null;
  activeUserCount7d: number | null;
  /** 互換: 主に online の推定。旧クライアント向け */
  count: number;
  asOf: string;
};

export const HERO_LIVE_USER_FALLBACK = 2_300;

const USER_STATS_PATH = "/user-stats";

export async function fetchPublicUserStats(): Promise<PublicUserStats> {
  const base = getApiBaseUrl().replace(/\/$/, "");
  const res = await fetch(`${base}${USER_STATS_PATH}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`user-stats: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<PublicUserStats>;
}

const AVATAR_LETTERS_POOL = ["A", "K", "M", "T", "R", "N", "S", "Y", "H", "L"];

function pickShuffledK(k: 1 | 2 | 3): string[] {
  return [...AVATAR_LETTERS_POOL]
    .sort(() => Math.random() - 0.5)
    .slice(0, k);
}

export function avatarCountForOnline(n: number): 1 | 2 | 3 {
  if (n <= 0) return 1;
  if (n < 16) return 1;
  if (n < 50) return 2;
  return 3;
}

export function pickAvatarLetters(online: number): string[] {
  return pickShuffledK(avatarCountForOnline(online));
}
