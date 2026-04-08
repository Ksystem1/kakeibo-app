import { useSettings } from "../context/SettingsContext";
import { useMemo, useState } from "react";
import { reclassifyUncategorizedReceipts } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function SettingsPage() {
  const {
    fontScale,
    setFontScale,
    fontMode,
    setFontMode,
    themeMode,
    setThemeMode,
    fixedCostsByMonth,
    setFixedCostForMonth,
  } = useSettings();
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyResult, setReclassifyResult] = useState<string | null>(null);
  const [fixedYm, setFixedYm] = useState(currentYm);
  const [fixedAmount, setFixedAmount] = useState(() =>
    String(fixedCostsByMonth[currentYm()] ?? ""),
  );

  const fixedCostRows = useMemo(
    () =>
      Object.entries(fixedCostsByMonth)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 12),
    [fixedCostsByMonth],
  );

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>設定</h1>
      <p className={styles.sub}>
        背景色（4 種）と文字サイズを変更します。
      </p>
      <div className={styles.settingsPanel} style={{ maxWidth: 360 }}>
        <label className={styles.settingsLabel}>表示テーマ</label>
        <div className={`${styles.modeRow} ${styles.modeRowTheme}`}>
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
          <button
            type="button"
            className={`${styles.btn} ${themeMode === "paper" ? styles.btnPrimary : ""}`}
            onClick={() => setThemeMode("paper")}
          >
            ペーパー
          </button>
          <button
            type="button"
            className={`${styles.btn} ${themeMode === "ocean" ? styles.btnPrimary : ""}`}
            onClick={() => setThemeMode("ocean")}
          >
            オーシャン
          </button>
        </div>
        <label className={styles.settingsLabel}>文字サイズモード</label>
        <div className={styles.modeRow}>
          <button
            type="button"
            className={`${styles.btn} ${fontMode === "small" ? styles.btnPrimary : ""}`}
            onClick={() => setFontMode("small")}
          >
            小
          </button>
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
        <h2 className={styles.sectionTitle}>固定費設定（月別）</h2>
        <p className={styles.reclassifyHint}>
          ここで入力した固定費は、家計簿の「品目別・支出」にカテゴリ「固定費」として表示されます。
        </p>
        <div className={styles.form} style={{ marginTop: "0.5rem" }}>
          <div className={styles.field}>
            <label htmlFor="fixed-ym">対象月</label>
            <input
              id="fixed-ym"
              type="month"
              value={fixedYm}
              onChange={(e) => {
                const ym = e.target.value;
                setFixedYm(ym);
                setFixedAmount(String(fixedCostsByMonth[ym] ?? ""));
              }}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="fixed-amount">固定費（円）</label>
            <input
              id="fixed-amount"
              type="number"
              min={0}
              step={1}
              placeholder="80000"
              value={fixedAmount}
              onChange={(e) => setFixedAmount(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => {
              const amount = Number.parseFloat(fixedAmount || "0");
              setFixedCostForMonth(fixedYm, Number.isFinite(amount) ? amount : 0);
            }}
          >
            保存
          </button>
        </div>
        {fixedCostRows.length > 0 ? (
          <div className={styles.tableWrap} style={{ marginTop: "0.75rem" }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>月</th>
                  <th>固定費</th>
                </tr>
              </thead>
              <tbody>
                {fixedCostRows.map(([ym, amount]) => (
                  <tr key={ym}>
                    <td>{ym}</td>
                    <td>¥{Number(amount).toLocaleString("ja-JP")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className={styles.settingsPanel} style={{ marginTop: "1.5rem", maxWidth: 420 }}>
        <h2 className={styles.sectionTitle}>レシート自動再分類</h2>
        <p className={styles.reclassifyHint}>
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
