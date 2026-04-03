import { useSettings } from "../context/SettingsContext";
import { useState } from "react";
import { reclassifyUncategorizedReceipts } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

export function SettingsPage() {
  const { fontScale, setFontScale, fontMode, setFontMode, themeMode, setThemeMode } = useSettings();
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyResult, setReclassifyResult] = useState<string | null>(null);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>設定</h1>
      <p className={styles.sub}>
        背景色（ライト/ダーク）と文字サイズを変更します（localStorage に保存）。
      </p>
      <div className={styles.settingsPanel} style={{ maxWidth: 360 }}>
        <label className={styles.settingsLabel}>表示テーマ</label>
        <div className={styles.modeRow}>
          <button
            type="button"
            className={`${styles.btn} ${themeMode === "light" ? styles.btnPrimary : ""}`}
            onClick={() => setThemeMode("light")}
          >
            ライト
          </button>
          <button
            type="button"
            className={`${styles.btn} ${themeMode === "dark" ? styles.btnPrimary : ""}`}
            onClick={() => setThemeMode("dark")}
          >
            ダーク
          </button>
        </div>
        <label className={styles.settingsLabel}>文字サイズモード</label>
        <div className={styles.modeRow}>
          <button
            type="button"
            className={`${styles.btn} ${fontMode === "standard" ? styles.btnPrimary : ""}`}
            onClick={() => setFontMode("standard")}
          >
            標準
          </button>
          <button
            type="button"
            className={`${styles.btn} ${fontMode === "large" ? styles.btnPrimary : ""}`}
            onClick={() => setFontMode("large")}
          >
            大
          </button>
          <button
            type="button"
            className={`${styles.btn} ${fontMode === "xlarge" ? styles.btnPrimary : ""}`}
            onClick={() => setFontMode("xlarge")}
          >
            特大
          </button>
        </div>
        <label htmlFor="font-range" className={styles.settingsLabel}>
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
          className={styles.settingsRange}
        />
      </div>

      <div className={styles.settingsPanel} style={{ marginTop: "1.5rem", maxWidth: 420 }}>
        <h2 className={styles.sectionTitle}>レシート自動再分類</h2>
        <p className={styles.sub} style={{ marginTop: 0, color: "#d9e7ff" }}>
          全期間の未分類の支出に対して、履歴・キーワードを使ってカテゴリを再推定します（件数が多いと時間がかかります）。
        </p>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={reclassifying}
          onClick={async () => {
            if (reclassifying) return;
            setReclassifyResult(null);
            setReclassifying(true);
            try {
              const r = await reclassifyUncategorizedReceipts();
              setReclassifyResult(
                `再分類完了: 走査 ${r.scanned} 件 / 更新 ${r.updated} 件`,
              );
            } catch (e) {
              setReclassifyResult(
                e instanceof Error ? e.message : String(e),
              );
            } finally {
              setReclassifying(false);
            }
          }}
        >
          {reclassifying ? "再分類中…" : "未分類を再分類する"}
        </button>
        {reclassifyResult ? (
          <p className={styles.infoText}>
            {reclassifyResult}
          </p>
        ) : null}
      </div>
    </div>
  );
}
