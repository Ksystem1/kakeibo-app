import { useCallback } from "react";
import styles from "./LoginScreen.module.css";

const TOASTS = [
  { amount: "¥5,000", label: "食費" },
  { amount: "¥1,200", label: "交通" },
  { amount: "固定費", label: "今月" },
  { amount: "¥2,100", label: "娯楽" },
];

export function LoginHeroPreview() {
  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    el.style.setProperty("--hx", `${x}%`);
    el.style.setProperty("--hy", `${y}%`);
  }, []);

  const onLeave = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty("--hx", "50%");
    e.currentTarget.style.setProperty("--hy", "50%");
  }, []);

  return (
    <div
      className={styles.heroPreviewShell}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      data-demo-hover-target
    >
      <div className={styles.heroPreviewShine} aria-hidden />
      <div className={styles.heroPreviewGloss} aria-hidden />
      <div className={styles.heroFigureTopBar} aria-hidden>
        <span />
        <span />
        <span />
      </div>

      <div className={styles.heroPreviewBody}>
        <div className={styles.heroChartGrid} aria-hidden>
          <div className={styles.heroBarSection}>
            <div className={styles.heroBarSet}>
              {[0.32, 0.55, 0.4, 0.72, 0.5, 0.68, 0.45].map((h, i) => (
                <div
                  key={i}
                  className={styles.heroBarPillar}
                  style={{ height: `calc(36% + ${h * 56}%)` }}
                />
              ))}
            </div>
            <p className={styles.heroBarCaption}>月別の支出</p>
          </div>
          <div className={styles.heroDonutBlock}>
            <div className={styles.heroDonut} />
            <p className={styles.heroBarCaption}>内訳</p>
          </div>
        </div>
        {TOASTS.map((t, i) => (
          <div
            key={t.label + t.amount + i}
            className={styles.heroFloatToast}
            data-toast-idx={i}
          >
            <span className={styles.heroFloatAmount}>{t.amount}</span>{" "}
            <span className={styles.heroFloatLabel}>{t.label}</span>
          </div>
        ))}
        <div className={styles.heroListSkeleton} aria-hidden>
          <span className={styles.heroSkLine} />
          <span className={styles.heroSkLine} />
          <span className={styles.heroSkLine} />
        </div>
      </div>
    </div>
  );
}
