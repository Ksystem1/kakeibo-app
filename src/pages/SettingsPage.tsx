import {
  getEffectiveFixedCostsForMonth,
  type FixedCostItem,
  useSettings,
} from "../context/SettingsContext";
import { useEffect, useMemo, useState } from "react";
import { getMonthSummary, reclassifyUncategorizedReceipts } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function currentYearStartYm() {
  return `${new Date().getFullYear()}-01`;
}

function currentYearEndYm() {
  return `${new Date().getFullYear()}-12`;
}

/** 対象月の初期値：当月に保存があれば当月、なければ当年で一番新しい保存月（明細がすぐ見えるようにする） */
function pickDefaultFixedYm(byMonth: Record<string, FixedCostItem[]>): string {
  const cur = currentYm();
  if ((byMonth[cur]?.length ?? 0) > 0) return cur;
  const y = new Date().getFullYear();
  const prefix = `${y}-`;
  const keys = Object.keys(byMonth)
    .filter(
      (k) =>
        /^\d{4}-\d{2}$/.test(k) &&
        k.startsWith(prefix) &&
        Array.isArray(byMonth[k]) &&
        byMonth[k].length > 0,
    )
    .sort((a, b) => b.localeCompare(a));
  return keys[0] ?? cur;
}

/** 編集フォーム用：まずその月の保存行、なければ直近の繰越、なければ1行の空フォーム（参照は新配列・行idはフォーム専用） */
function itemsForFixedCostEditor(
  ym: string,
  fixedCostsByMonth: Record<string, FixedCostItem[]>,
): FixedCostItem[] {
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    return [{ id: `fixed-${Date.now()}`, amount: 0, category: "固定費" }];
  }
  const direct = fixedCostsByMonth[ym];
  if (Array.isArray(direct) && direct.length > 0) {
    return direct.map((x, i) => ({
      id: `edit-${ym}-${i}`,
      amount: Math.max(0, Math.round(Number(x.amount) || 0)),
      category: String(x.category ?? "").slice(0, 40),
    }));
  }
  const inherited = getEffectiveFixedCostsForMonth(fixedCostsByMonth, ym);
  if (inherited.length > 0) {
    return inherited.map((x, i) => ({
      id: `edit-${ym}-${i}`,
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
  const [fixedYm, setFixedYm] = useState(() => pickDefaultFixedYm(fixedCostsByMonth));
  const [monthExpenseTotal, setMonthExpenseTotal] = useState<number>(0);
  const [checkingMonth, setCheckingMonth] = useState(false);
  const [fixedItems, setFixedItems] = useState<FixedCostItem[]>(() =>
    itemsForFixedCostEditor(pickDefaultFixedYm(fixedCostsByMonth), fixedCostsByMonth),
  );

  const fixedCostRows = useMemo(
    () =>
      Object.entries(fixedCostsByMonth)
        .map(([ym, items]) => ({
          ym,
          total: items.reduce((acc, x) => acc + Number(x.amount || 0), 0),
          count: items.length,
        }))
        .filter((x) => x.total > 0)
        .sort((a, b) => b.ym.localeCompare(a.ym))
        .slice(0, 12),
    [fixedCostsByMonth],
  );
  const sameYearEditable = fixedYm >= currentYearStartYm() && fixedYm <= currentYearEndYm();
  const hasExpenseMonth = monthExpenseTotal > 0;
  const hasSavedFixedForMonth = (fixedCostsByMonth[fixedYm]?.length ?? 0) > 0;
  const fixedCostEditable =
    sameYearEditable && (hasExpenseMonth || hasSavedFixedForMonth);

  useEffect(() => {
    let cancelled = false;
    if (!/^\d{4}-\d{2}$/.test(fixedYm)) {
      setMonthExpenseTotal(0);
      return;
    }
    setCheckingMonth(true);
    getMonthSummary(fixedYm)
      .then((summary) => {
        if (cancelled) return;
        const total = Number(summary?.expenseTotal ?? 0);
        setMonthExpenseTotal(Number.isFinite(total) ? total : 0);
      })
      .catch(() => {
        if (cancelled) return;
        setMonthExpenseTotal(0);
      })
      .finally(() => {
        if (!cancelled) setCheckingMonth(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fixedYm]);

  useEffect(() => {
    setFixedItems(itemsForFixedCostEditor(fixedYm, fixedCostsByMonth));
  }, [fixedYm, fixedCostsByMonth]);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>設定</h1>
      <p className={styles.sub}>
        背景色（4 種）と文字サイズを変更します。
      </p>
      <div className={styles.settingsPanel} style={{ maxWidth: 820 }}>
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
        <h2 className={styles.sectionTitle}>固定費設定（月別）</h2>
        <p className={styles.reclassifyHint}>
          各月の固定費は、この画面で登録した金額の合計（サマリー金額）を「固定費」として表示します。
        </p>
        {!sameYearEditable ? (
          <p className={styles.infoText}>固定費は同じ年（当年）の月のみ変更できます。</p>
        ) : !checkingMonth && !hasExpenseMonth && !hasSavedFixedForMonth ? (
          <p className={styles.infoText}>
            支出がある月に新規で固定費を登録できます。既に保存した月は、支出がなくても編集できます。
          </p>
        ) : null}
        <div className={styles.form} style={{ marginTop: "0.5rem" }}>
          <div className={styles.field}>
            <label htmlFor="fixed-ym">対象月</label>
            <input
              id="fixed-ym"
              type="month"
              value={fixedYm}
              min={currentYearStartYm()}
              max={currentYearEndYm()}
              style={{ maxWidth: 180 }}
              onChange={(e) => {
                setFixedYm(e.target.value);
              }}
            />
          </div>
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
                      if (!fixedCostEditable) return;
                      const next = [...fixedItems];
                      next[idx] = { ...next[idx], category: e.target.value };
                      setFixedItems(next);
                    }}
                    disabled={!fixedCostEditable}
                  />
                  <input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="金額"
                    value={item.amount > 0 ? String(item.amount) : ""}
                    onChange={(e) => {
                      if (!fixedCostEditable) return;
                      const next = [...fixedItems];
                      const n = Number.parseFloat(e.target.value || "0");
                      next[idx] = { ...next[idx], amount: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 };
                      setFixedItems(next);
                    }}
                    disabled={!fixedCostEditable}
                  />
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => {
                      if (!fixedCostEditable) return;
                      const next = fixedItems.filter((x) => x.id !== item.id);
                      setFixedItems(next.length > 0 ? next : [{ id: `fixed-${Date.now()}`, amount: 0, category: "固定費" }]);
                    }}
                    disabled={!fixedCostEditable}
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
              fixedCostEditable &&
              setFixedItems((prev) => [...prev, { id: `fixed-${Date.now()}-${prev.length}`, amount: 0, category: "固定費" }])
            }
            disabled={!fixedCostEditable}
          >
            入力行を追加
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => {
              if (!fixedCostEditable) return;
              setFixedCostsForMonth(fixedYm, fixedItems);
            }}
            disabled={!fixedCostEditable}
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
                {fixedCostRows.map((row) => (
                  <tr
                    key={row.ym}
                    style={{ cursor: "pointer" }}
                    title="クリックしてこの月の明細を編集"
                    onClick={() => setFixedYm(row.ym)}
                  >
                    <td>{row.ym}</td>
                    <td>¥{Number(row.total).toLocaleString("ja-JP")}（{row.count}件）</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
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
