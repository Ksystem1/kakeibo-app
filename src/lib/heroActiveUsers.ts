import { getApiBaseUrl } from "./api";

/**
 * ランディング/ログイン用の利用者数（GET /user-stats、API 失敗時はフック側でフォールバック）。
 */
export type PublicUserStats = {
  count: number;
  registeredUserCount: number;
  activeUserCount7d: number | null;
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

function pickThreeShuffled(): string[] {
  const s = [...AVATAR_LETTERS_POOL]
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);
  return s;
}

export function randomAvatarLetters(
  current: string[],
  force = false,
): { next: string[]; changed: boolean } {
  if (!force && Math.random() > 0.35) {
    return { next: current, changed: false };
  }
  return { next: pickThreeShuffled(), changed: true };
}
