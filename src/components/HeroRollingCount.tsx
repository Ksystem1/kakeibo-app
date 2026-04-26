import styles from "./LoginScreen.module.css";

type Props = {
  value: string;
  className?: string;
  "aria-live"?: "off" | "polite" | "assertive";
  "aria-atomic"?: boolean;
  "aria-busy"?: boolean;
  "data-provisional"?: "true";
};

function RollingDigit({ digit }: { digit: number }) {
  return (
    <span className={styles.heroRollDigit} aria-hidden>
      <span
        className={styles.heroRollStrip}
        style={{ transform: `translate3d(0, calc(-1em * ${digit}), 0)` }}
      >
        {Array.from({ length: 10 }, (_, d) => (
          <span key={d} className={styles.heroRollNum}>
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * 表示文字列（例: +2,300 または —）の数字列をドラム式に。記号は静的。
 */
export function HeroRollingCount({
  value,
  className,
  "aria-live": ariaLive,
  "aria-atomic": ariaAtomic,
  "aria-busy": ariaBusy,
  "data-provisional": dataProvisional,
}: Props) {
  const items: { key: string; t: "d" | "s"; ch?: string; d?: number }[] = [];
  let dIdx = 0;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      const i = dIdx;
      dIdx += 1;
      items.push({ key: `d${i}`, t: "d", d: Number(ch) });
    } else {
      items.push({ key: `s${items.length}${ch}`, t: "s", ch });
    }
  }

  return (
    <span
      className={className}
      aria-live={ariaLive}
      aria-atomic={ariaAtomic}
      aria-busy={ariaBusy}
      data-provisional={dataProvisional}
    >
      {items.map((p) =>
        p.t === "s" && p.ch != null ? (
          <span key={p.key} className={styles.heroRollStatic}>
            {p.ch}
          </span>
        ) : p.d != null && p.t === "d" ? (
          <RollingDigit key={p.key} digit={p.d} />
        ) : null,
      )}
    </span>
  );
}
