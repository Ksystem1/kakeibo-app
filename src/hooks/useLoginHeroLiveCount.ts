import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  fetchPublicUserStats,
  HERO_LIVE_USER_FALLBACK,
  randomAvatarLetters,
} from "../lib/heroActiveUsers";

const REFETCH_MS = 3 * 60 * 1000;
const STALE_MS = 2 * 60 * 1000;

function pickDisplayCount(data: { count: number } | undefined): number {
  if (data && Number.isFinite(data.count)) {
    return Math.max(0, Math.floor(data.count));
  }
  return HERO_LIVE_USER_FALLBACK;
}

/**
 * ログイン英雄部の利用者数（GET /user-stats + 数分間隔の再取得）とアバター装飾。
 * 数値は API の実数をそのまま表示（チック更新はせず、HeroRollingCount は文字列が変わったときだけ回転）。
 */
export function useLoginHeroLiveCount() {
  const { data, isFetching, isError, error } = useQuery({
    queryKey: ["public", "user-stats"] as const,
    queryFn: fetchPublicUserStats,
    refetchInterval: REFETCH_MS,
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const display = pickDisplayCount(data);
  const target = display;
  const [avatarLetters, setAvatarLetters] = useState<string[]>(["A", "K", "M"]);
  const [avatarJiggle, setAvatarJiggle] = useState(0);
  const lastServerCount = useRef<number | null>(null);

  /** 初回取得前のみ。再取得中は data が保たれフォールバック同幅のまま。 */
  const isProvisional = data == null && isFetching;

  useEffect(() => {
    if (isError && data == null) {
      if (import.meta.env.DEV && error) {
        // eslint-disable-next-line no-console
        console.warn("[user-stats] using fallback", error);
      }
    }
  }, [isError, data, error]);

  useEffect(() => {
    if (data == null || !Number.isFinite(data.count)) return;
    if (lastServerCount.current !== null && data.count !== lastServerCount.current) {
      setAvatarJiggle((k) => k + 1);
      setAvatarLetters((cur) => {
        const { next } = randomAvatarLetters(cur, true);
        return next;
      });
    }
    lastServerCount.current = data.count;
  }, [data?.count, data]);

  return {
    display,
    target,
    avatarLetters,
    avatarJiggle,
    isProvisional,
  };
}
