import {
  type FixedCostItem,
  useSettings,
} from "../context/SettingsContext";
import { useEffect, useMemo, useState } from "react";
import { reclassifyUncategorizedReceipts } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";
import { CategoriesPage } from "./CategoriesPage";
import { MembersPage } from "./MembersPage";

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function itemsForFixedCostEditor(
  fixedCostsByMonth: Record<string, FixedCostItem[]>,
): FixedCostItem[] {
  const keys = Object.keys(fixedCostsByMonth)
    .filter((k) => Array.isArray(fixedCostsByMonth[k]) && fixedCostsByMonth[k].length > 0)
    .sort((a, b) => b.localeCompare(a));
  const base = keys[0] ? fixedCostsByMonth[keys[0]] : [];
  if (Array.isArray(base) && base.length > 0) {
    return base.map((x, i) => ({
      id: `edit-${i}`,
      amount: Math.max(0, Math.round(Number(x.amount) || 0)),
      category: String(x.category ?? "").slice(0, 40),
    }));
  }
  return [{ id: `fixed-${Date.now()}`, amount: 0, category: "固定費" }];
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
    setFixedCostsForMonth,
  } = useSettings();
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyResult, setReclassifyResult] = useState<string | null>(null);
  const [fixedItems, setFixedItems] = useState<FixedCostItem[]>(() =>
    itemsForFixedCostEditor(fixedCostsByMonth),
  );

  const fixedCostTotal = useMemo(
    () => fixedItems.reduce((acc, x) => acc + Number(x.amount || 0), 0),
    [fixedItems],
  );

  useEffect(() => {
    setFixedItems(itemsForFixedCostEditor(fixedCostsByMonth));
  }, [fixedCostsByMonth]);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>設定</h1>
      <div className={styles.settingsPanel} style={{ marginTop: "0.75rem", maxWidth: 980 }}>
        <h2 className={styles.sectionTitle}>家族・利用ユーザー</h2>
        <p className={styles.reclassifyHint}>
          同じ家族に紐づいた人は取引の入力・閲覧ができます。メール登録で招待URLを発行します。
        </p>
        <MembersPage embedded />
      </div>
      <div className={styles.settingsPanel} style={{ maxWidth: 820 }}>
        <p className={styles.sub} style={{ margin: "0 0 0.5rem" }}>
          背景色（4 種）と文字サイズを変更します。
        </p>
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
        </div>
        <label htmlFor="font-range" className={styles.settingsLabel}>
          文字サイズ: {Math.round(fontScale * 100)}%
        </label>
        <input
          id="font-range"
          type="range"
          min={0.85}
          max={1.2}
          step={0.05}
          value={fontScale}
          onChange={(e) => setFontScale(Number.parseFloat(e.target.value))}
          className={styles.settingsRange}
        />
      </div>

      <div className={styles.settingsPanel} style={{ marginTop: "1.5rem", maxWidth: 720 }}>
        <h2 className={styles.sectionTitle}>固定費設定（全月共通）</h2>
        <p className={styles.reclassifyHint}>
          ここで保存した固定費はすべての月に適用されます。保存時は既存の月別設定を上書きします。
        </p>
        <div className={styles.form} style={{ marginTop: "0.5rem" }}>
          <div className={styles.field} style={{ gridColumn: "1 / -1" }}>
            <label>固定費入力（1行 = カテゴリ + 金額 / カテゴリは自由入力）</label>
            <div style={{ display: "grid", gap: 8 }}>
              {fixedItems.map((item, idx) => (
                <div key={item.id} style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 8 }}>
                  <input
                    type="text"
                    placeholder="カテゴリ（自由入力: 例 家賃 / サブスク）"
                    value={item.category}
                    onChange={(e) => {
                      const next = [...fixedItems];
                      next[idx] = { ...next[idx], category: e.target.value };
                      setFixedItems(next);
                    }}
                  />
                  <input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="金額"
                    value={item.amount > 0 ? String(item.amount) : ""}
                    onChange={(e) => {
                      const next = [...fixedItems];
                      const n = Number.parseFloat(e.target.value || "0");
                      next[idx] = { ...next[idx], amount: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 };
                      setFixedItems(next);
                    }}
                  />
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => {
                      const next = fixedItems.filter((x) => x.id !== item.id);
                      setFixedItems(next.length > 0 ? next : [{ id: `fixed-${Date.now()}`, amount: 0, category: "固定費" }]);
                    }}
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={styles.btn}
            onClick={() =>
              setFixedItems((prev) => [...prev, { id: `fixed-${Date.now()}-${prev.length}`, amount: 0, category: "固定費" }])
            }
          >
            入力行を追加
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => {
              setFixedCostsForMonth(currentYm(), fixedItems);
            }}
          >
            保存
          </button>
        </div>
        <p className={styles.infoText}>固定費合計: ¥{fixedCostTotal.toLocaleString("ja-JP")}</p>
      </div>

      <div className={styles.settingsPanel} style={{ marginTop: "1.5rem", maxWidth: 980 }}>
        <h2 className={styles.sectionTitle}>カテゴリ管理</h2>
        <p className={styles.reclassifyHint}>
          支出・収入のカテゴリを追加・変更・削除できます。
        </p>
        <CategoriesPage embedded />
      </div>

      <div className={styles.settingsPanel} style={{ marginTop: "1.5rem", maxWidth: 720 }}>
        <h2 className={styles.sectionTitle}>レシート自動再分類</h2>
        <p className={styles.reclassifyHint}>
          全期間の未分類を、履歴・キーワードより再推定します
          <br />
          （件数が多いと時間がかかります）。
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
