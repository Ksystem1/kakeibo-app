import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./PullToRefresh.module.css";

const MQ_MOBILE = "(max-width: 768px)";
const PULL_RESIST = 0.42;
const PULL_MAX = 96;
const RELEASE_RELOAD = 56;

function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof Element)) return false;
  const node = el.closest("input, textarea, select, [contenteditable='true']");
  if (!node) return false;
  if (node instanceof HTMLInputElement) {
    const t = node.type;
    if (
      t === "checkbox" ||
      t === "radio" ||
      t === "range" ||
      t === "button" ||
      t === "submit" ||
      t === "reset" ||
      t === "file" ||
      t === "hidden"
    ) {
      return false;
    }
  }
  return true;
}

function isInteractiveTapTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof Element)) return false;
  return Boolean(
    el.closest(
      "a, button, label, summary, details, [role='button'], [role='link'], [data-no-pull-refresh='1']",
    ),
  );
}

function pageScrollTop(): number {
  const se = document.scrollingElement ?? document.documentElement;
  return se.scrollTop ?? 0;
}

function getTouch(ev: TouchEvent, id: number): Touch | undefined {
  return [...ev.touches].find((x) => x.identifier === id);
}

/** 指の下に、まだ上端でないスクロール領域があるか（ネストスクロール対策） */
function nestedScrollNotAtTop(el: Element | null): boolean {
  let node: Element | null = el;
  while (node && node !== document.body && node !== document.documentElement) {
    const st = getComputedStyle(node);
    const oy = st.overflowY;
    const elh = node as HTMLElement;
    const scrollable =
      (oy === "auto" || oy === "scroll" || oy === "overlay") &&
      elh.scrollHeight > elh.clientHeight + 1;
    if (scrollable && elh.scrollTop > 2) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * モバイル幅のみ: ページ先頭で下方向にスワイプするとフルリロード。
 * ライブラリ不使用（タッチ + CSS のみ）。
 */
export function PullToRefresh() {
  const [pullPx, setPullPx] = useState(0);
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [enabled, setEnabled] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MQ_MOBILE).matches,
  );

  const startYRef = useRef(0);
  const startXRef = useRef(0);
  const armedRef = useRef(false);
  const pullingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pullStoredRef = useRef(0);
  const touchIdRef = useRef<number | null>(null);

  const applyPull = useCallback((px: number) => {
    pullStoredRef.current = px;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const p = pullStoredRef.current;
      setPullPx(p);
      setReady(p >= RELEASE_RELOAD);
    });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(MQ_MOBILE);
    const onMq = () => setEnabled(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    return () => mq.removeEventListener("change", onMq);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setPullPx(0);
      setReady(false);
      return undefined;
    }
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return undefined;
    }

    const onTouchStart = (ev: TouchEvent) => {
      if (refreshing) return;
      if (ev.touches.length !== 1) return;
      const t = ev.touches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (isInteractiveTapTarget(el)) return;
      if (isEditableTarget(el)) return;
      if (pageScrollTop() > 2) return;
      if (nestedScrollNotAtTop(el)) return;
      armedRef.current = true;
      pullingRef.current = false;
      touchIdRef.current = t.identifier;
      startYRef.current = t.clientY;
      startXRef.current = t.clientX;
      applyPull(0);
    };

    const onTouchMove = (ev: TouchEvent) => {
      if (refreshing) return;
      if (!armedRef.current || touchIdRef.current == null) return;
      const active = getTouch(ev, touchIdRef.current);
      if (!active) return;

      const dy = active.clientY - startYRef.current;
      const dx = active.clientX - startXRef.current;

      if (!pullingRef.current) {
        if (dy < 4) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.15) {
          armedRef.current = false;
          applyPull(0);
          return;
        }
        if (pageScrollTop() > 2) {
          armedRef.current = false;
          return;
        }
        pullingRef.current = true;
      }

      if (!pullingRef.current) return;

      const rubber = Math.min(Math.max(0, dy) * PULL_RESIST, PULL_MAX);
      if (rubber > 0) {
        ev.preventDefault();
      }
      applyPull(rubber);
    };

    const endGesture = () => {
      if (refreshing) return;
      const wasPull = pullingRef.current;
      const h = pullStoredRef.current;
      armedRef.current = false;
      pullingRef.current = false;
      touchIdRef.current = null;

      if (wasPull && h >= RELEASE_RELOAD) {
        setRefreshing(true);
        setPullPx(Math.min(h + 10, PULL_MAX));
        window.setTimeout(() => {
          window.location.reload();
        }, 120);
        return;
      }
      setPullPx(0);
      setReady(false);
    };

    const onTouchEnd = () => endGesture();
    const onTouchCancel = () => endGesture();

    document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true, capture: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart, { capture: true } as AddEventListenerOptions);
      document.removeEventListener("touchmove", onTouchMove, { capture: true } as AddEventListenerOptions);
      document.removeEventListener("touchend", onTouchEnd, { capture: true } as AddEventListenerOptions);
      document.removeEventListener("touchcancel", onTouchCancel, { capture: true } as AddEventListenerOptions);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [applyPull, enabled, refreshing]);

  if (!enabled) return null;

  const pad = refreshing ? Math.max(pullPx, 52) : pullPx;
  const showChip = pad > 2 || refreshing;

  return (
    <div
      className={styles.track}
      style={{
        paddingTop: showChip ? pad : 0,
      }}
      aria-hidden={!showChip}
    >
      {showChip ? (
        <div className={`${styles.inner}${ready || refreshing ? ` ${styles.innerReady}` : ""}`}>
          <span className={`${styles.icon} ${refreshing ? styles.iconSpin : ""}`} aria-hidden />
          <span className={styles.label} role="status" aria-live="polite">
            {refreshing
              ? "更新中…"
              : ready
                ? "離して更新"
                : "下にスワイプで再読込"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
