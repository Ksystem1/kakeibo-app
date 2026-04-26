import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCountUpFirst } from "./useCountUpFirst";
import {
  fetchPublicUserStats,
  HERO_LIVE_USER_FALLBACK,
  pickAvatarLetters,
} from "../lib/heroActiveUsers";

const REFETCH_MS = 60_000;
const STALE_MS = 30_000;

/**
 * ログイン英雄: GET /user-stats、登録のカウントアップ＋オンラインの参照。
 */
export function useLoginHeroLiveCount() {
  const { data, isError, isFetching, error } = useQuery({
    queryKey: ["public", "user-stats"] as const,
    queryFn: fetchPublicUserStats,
    refetchInterval: REFETCH_MS,
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const isProvisional = data == null && isFetching;

  const regTarget = useMemo(() => {
    if (data != null && Number.isFinite(data.registeredUserCount)) {
      return Math.max(0, Math.floor(data.registeredUserCount));
    }
    if (isError) return HERO_LIVE_USER_FALLBACK;
    return null;
  }, [data, isError]);

  const registeredDisplay = useCountUpFirst(regTarget, {
    durationMs: 1050,
    instant: Boolean(
      isError && (data == null || !Number.isFinite(data?.registeredUserCount as number)),
    ),
  });

  const [avatarLetters, setAvatarLetters] = useState<string[]>(["A", "K", "M"]);
  const [avatarJiggle, setAvatarJiggle] = useState(0);
  const lastOnline = useRef<number | null>(null);

  useEffect(() => {
    if (data == null) return;
    if (data.onlineUserCount5m == null) {
      setAvatarLetters(["A", "K", "M"]);
      return;
    }
    const o = data.onlineUserCount5m;
    if (lastOnline.current == null) {
      setAvatarLetters(pickAvatarLetters(o));
    } else if (o !== lastOnline.current) {
      setAvatarJiggle((k) => k + 1);
      setAvatarLetters(pickAvatarLetters(o));
    }
    lastOnline.current = o;
  }, [data]);

  useEffect(() => {
    if (isError && data == null) {
      if (import.meta.env.DEV && error) {
        // eslint-disable-next-line no-console
        console.warn("[user-stats]", error);
      }
    }
  }, [isError, data, error]);

  const onlineFormatted = useMemo(() => {
    if (data == null) return "0";
    if (data.onlineUserCount5m == null) return "—";
    return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(
      data.onlineUserCount5m,
    );
  }, [data]);

  return {
    registeredDisplay,
    isProvisional,
    isError,
    hasOnlineColumn: data != null && data.onlineUserCount5m != null,
    onlineFormatted,
    onlineApi: data?.onlineUserCount5m ?? null,
    asOf: data?.asOf,
    avatarLetters,
    avatarJiggle,
  };
}
