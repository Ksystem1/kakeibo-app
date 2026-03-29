import { useSettings } from "../context/SettingsContext";
import styles from "../components/KakeiboDashboard.module.css";

export function SettingsPage() {
  const { fontScale, setFontScale } = useSettings();

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>設定</h1>
      <p className={styles.sub}>
        表示の文字サイズを変更します（PC・スマホ共通。localStorage に保存）。
      </p>
      <div style={{ marginTop: "1rem", maxWidth: 360 }}>
        <label
          htmlFor="font-range"
          style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.9rem" }}
        >
          文字サイズ: {Math.round(fontScale * 100)}%
        </label>
        <input
          id="font-range"
          type="range"
          min={0.85}
          max={1.35}
          step={0.05}
          value={fontScale}
          onChange={(e) => setFontScale(Number.parseFloat(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
}
