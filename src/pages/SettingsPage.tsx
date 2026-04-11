import {
  type FixedCostItem,
  useSettings,
} from "../context/SettingsContext";
import { useAuth } from "../context/AuthContext";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { usePwaTargetDevice } from "../hooks/usePwaTargetDevice";
import {
  canSendAuthenticatedRequest,
  getApiBaseUrl,
  reclassifyUncategorizedReceipts,
} from "../lib/api";
import {
  clearPwaInstallBannerHidden,
  isPwaInstallBannerHidden,
  setPwaInstallBannerHidden,
  subscribePwaInstallPrefs,
} from "../lib/pwaInstallPrefs";
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
  const location = useLocation();
  const pwaTarget = usePwaTargetDevice();
  const [pwaBannerHidden, setPwaBannerHidden] = useState(isPwaInstallBannerHidden);
  const settingsBookmarkUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const base = import.meta.env.BASE_URL.replace(/\/$/, "") || "";
    return `${window.location.origin}${base}/settings`;
  }, []);

  useEffect(() => subscribePwaInstallPrefs(() => setPwaBannerHidden(isPwaInstallBannerHidden())), []);

  useEffect(() => {
    const h = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (location.pathname !== "/settings" || h !== "pwa-install-help") return;
    requestAnimationFrame(() => {
      document.getElementById("pwa-install-help")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, [location.hash, location.pathname]);

  const { token } = useAuth();
  const {
    fontScale,
    setFontScale,
    fontMode,
    setFontMode,
    themeMode,
    setThemeMode,
    fixedCostsByMonth,
    setFixedCostsForMonth,
    navSkinOptions,
    setNavSkinId,
  } = useSettings();
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyResult, setReclassifyResult] = useState<string | null>(null);
  const [fixedSaveBusy, setFixedSaveBusy] = useState(false);
  const [fixedSaveMessage, setFixedSaveMessage] = useState<string | null>(null);
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

      <div className={styles.settingsPanel} style={{ marginTop: "1.25rem", maxWidth: 820 }}>
        <h2 className={styles.sectionTitle}>ナビアイコンのスキン</h2>
        <p className={styles.reclassifyHint}>
          下部タブのアイコン画像のセットです。未購入のスキンは鍵付きで選べません。
        </p>
        <div
          className={styles.modeRow}
          style={{ marginTop: "0.5rem", flexWrap: "wrap", gap: "0.4rem" }}
        >
          {navSkinOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={!opt.unlocked}
              className={`${styles.btn} ${opt.selected ? styles.btnPrimary : ""}`}
              aria-pressed={opt.selected}
              aria-label={
                opt.unlocked
                  ? `${opt.label}に切り替え`
                  : `${opt.label}（未購入のため選択できません）`
              }
              onClick={() => setNavSkinId(opt.id)}
            >
              {opt.unlocked ? "" : "🔒 "}
              {opt.label}
            </button>
          ))}
        </div>
        {navSkinOptions.some((o) => !o.unlocked) ? (
          <p className={styles.sub} style={{ margin: "0.6rem 0 0", fontSize: "0.78rem" }}>
            購入後はアカウントに紐づけて解放する想定です（開発確認は localStorage の
            <code style={{ margin: "0 0.2rem" }}>kakeibo_owned_nav_skins</code>
            に
            <code style={{ margin: "0 0.2rem" }}>[&quot;Tmp02&quot;]</code>
            などの JSON 配列）。
          </p>
        ) : null}
      </div>

      {pwaTarget ? (
        <div
          id="pwa-install-help"
          className={styles.settingsPanel}
          style={{ marginTop: "1.5rem", maxWidth: 720 }}
        >
          <h2 className={styles.sectionTitle}>ホーム画面に追加（アプリのように使う）</h2>
          <p className={styles.reclassifyHint}>
            スマホ・タブレットでは、ブラウザを開かずに起動できるようにできます。下のリンクをブックマークしたり、ホームに追加した場合は、画面下の案内は表示しなくて構いません。
          </p>
          <ul className={styles.reclassifyHint} style={{ marginTop: "0.35rem", paddingLeft: "1.1rem" }}>
            <li>
              <strong>Android（Chrome）</strong>: メニュー（⋮）の「アプリをインストール」または「ホーム画面に追加」、または画面下の「ホームに追加」から追加できます。
            </li>
            <li>
              <strong>iPhone / iPad（Safari）</strong>: 共有ボタンから「ホーム画面に追加」を選びます。
            </li>
          </ul>
          <p className={styles.reclassifyHint} style={{ marginTop: "0.5rem" }}>
            この設定ページへのリンク:{" "}
            <a href={settingsBookmarkUrl} style={{ wordBreak: "break-all" }}>
              {settingsBookmarkUrl || "（読み込み中）"}
            </a>
          </p>
          <div className={styles.modeRow} style={{ marginTop: "0.65rem", flexWrap: "wrap" }}>
            {pwaBannerHidden ? (
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  clearPwaInstallBannerHidden();
                }}
              >
                下の案内バーを再表示する
              </button>
            ) : (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => {
                  setPwaInstallBannerHidden();
                }}
              >
                追加済み・ショートカット利用中（案内を出さない）
              </button>
            )}
          </div>
        </div>
      ) : null}

      <div className={styles.settingsPanel} style={{ marginTop: "1.5rem", maxWidth: 720 }}>
        <h2 className={styles.sectionTitle}>固定費設定（全月共通）</h2>
        <p className={styles.reclassifyHint}>
          ここで保存した固定費はすべての月に適用されます。ログイン済みの場合は家族単位でサーバに保存され、同じ家族のメンバーがどの端末からでも同じ内容を参照できます。
          {!getApiBaseUrl() || !canSendAuthenticatedRequest(token)
            ? " API に接続できない、またはログイン・開発用ユーザー設定がない場合は、この端末の画面にのみ反映されます。"
            : null}
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
            disabled={fixedSaveBusy}
            onClick={async () => {
              setFixedSaveBusy(true);
              setFixedSaveMessage(null);
              try {
                await setFixedCostsForMonth(currentYm(), fixedItems);
                setFixedSaveMessage(
                  getApiBaseUrl() && canSendAuthenticatedRequest(token)
                    ? "保存しました（家族で共有）。"
                    : "保存しました（この端末のみ）。",
                );
              } catch (e) {
                setFixedSaveMessage(
                  e instanceof Error ? e.message : String(e),
                );
              } finally {
                setFixedSaveBusy(false);
              }
            }}
          >
            {fixedSaveBusy ? "保存中…" : "保存"}
          </button>
        </div>
        {fixedSaveMessage ? (
          <p className={styles.infoText}>{fixedSaveMessage}</p>
        ) : null}
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
