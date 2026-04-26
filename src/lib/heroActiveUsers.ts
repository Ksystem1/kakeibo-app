/**
 * ランディング/ログイン用の「利用中ユーザー数」等。
 * 実装時: GET /public/stats など。未接続の間は null（UIはフォールバック値を使う）。
 */
export async function fetchPublicActiveUserCount(): Promise<number | null> {
  // 将来: return fetchJson<number>(`${publicApi}/active-user-count`, ...);
  return null;
}

export const HERO_LIVE_USER_FALLBACK = 2_300;

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
