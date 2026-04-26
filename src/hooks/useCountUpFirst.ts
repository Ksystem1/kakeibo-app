import { useEffect, useRef, useState } from "react";

type Opts = {
  durationMs?: number;
  /** エラー時のフォールバックなど、0 から数える必要がないとき */
  instant?: boolean;
};

/**
 * 目標が初めて得られた一度だけ 0 から目標へイージング。以降の目標変更は即座に数値追従。
 */
export function useCountUpFirst(
  target: number | null,
  { durationMs = 1100, instant = false }: Opts = {},
) {
  const [v, setV] = useState(0);
  const hasFinishedFirst = useRef(false);
  const rafRef = useRef<number | null>(null);
  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) {
      if (!hasFinishedFirst.current) setV(0);
      return;
    }
    const t = Math.max(0, Math.floor(target));

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (instant || reduce) {
      setV(t);
      hasFinishedFirst.current = true;
      return;
    }

    if (hasFinishedFirst.current) {
      setV(t);
      return;
    }

    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const ease = 1 - (1 - p) ** 3;
      setV(Math.floor(t * ease));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setV(t);
        hasFinishedFirst.current = true;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, durationMs, instant, reduce]);

  return v;
}
