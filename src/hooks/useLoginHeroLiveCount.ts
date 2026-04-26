import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchPublicActiveUserCount,
  HERO_LIVE_USER_FALLBACK,
  randomAvatarLetters,
} from "../lib/heroActiveUsers";

const SIM_MIN_MS = 3_000;
const SIM_MAX_MS = 5_500;
const TICK_MS = 30;

function nextSimDelay(): number {
  return SIM_MIN_MS + Math.floor(Math.random() * (SIM_MAX_MS - SIM_MIN_MS));
}

function stepDisplay(current: number, target: number): number {
  if (current >= target) return current;
  const diff = target - current;
  if (diff > 400) {
    return current + Math.max(1, Math.floor(diff / 16));
  }
  if (diff > 60) {
    return current + Math.max(1, Math.floor(diff / 10));
  }
  if (diff > 12) {
    return current + Math.max(1, Math.ceil(diff / 6));
  }
  return current + 1;
}

export function useLoginHeroLiveCount() {
  const [target, setTarget] = useState<number | null>(null);
  const [display, setDisplay] = useState(0);
  const [avatarLetters, setAvatarLetters] = useState<string[]>(["A", "K", "M"]);
  const [avatarJiggle, setAvatarJiggle] = useState(0);
  const targetRef = useRef(0);
  /** ブラウザのタイマー ID（Node の `NodeJS.Timeout` との衝突を避ける） */
  const simTimeoutRef = useRef<number | null>(null);
  const tickIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const n = await fetchPublicActiveUserCount();
      if (cancelled) return;
      setTarget(n ?? HERO_LIVE_USER_FALLBACK);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (target == null) return;
    targetRef.current = target;
  }, [target]);

  const isTargetSet = target != null;
  // display を target に追従（0→初回値のカウントアップ＋以降の差分追従）
  useEffect(() => {
    if (!isTargetSet) {
      if (tickIntervalRef.current != null) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      return;
    }
    if (tickIntervalRef.current != null) {
      clearInterval(tickIntervalRef.current);
    }
    tickIntervalRef.current = window.setInterval(() => {
      setDisplay((d) => {
        const t = targetRef.current;
        if (d >= t) return d;
        return stepDisplay(d, t);
      });
    }, TICK_MS);
    return () => {
      if (tickIntervalRef.current != null) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
    };
  }, [isTargetSet]);

  const runSimStep = useCallback(() => {
    setTarget((prev) => {
      if (prev == null) return prev;
      const add = 1 + Math.floor(Math.random() * 3);
      const n = prev + add;
      targetRef.current = n;
      return n;
    });
    setAvatarLetters((cur) => {
      const { next, changed } = randomAvatarLetters(cur, false);
      if (changed) {
        setAvatarJiggle((k) => k + 1);
      }
      return next;
    });
  }, []);

  // 初回に target が得られた直後の一度だけ: 数秒ランダム間隔でシミュレーター
  const hasTarget = target != null;
  useEffect(() => {
    if (!hasTarget) return;
    const schedule = () => {
      simTimeoutRef.current = window.setTimeout(() => {
        runSimStep();
        schedule();
      }, nextSimDelay());
    };
    schedule();
    return () => {
      if (simTimeoutRef.current != null) {
        clearTimeout(simTimeoutRef.current);
        simTimeoutRef.current = null;
      }
    };
  }, [hasTarget, runSimStep]);

  return { display, target, avatarLetters, avatarJiggle };
}
