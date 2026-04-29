import {
  type FixedCostItem,
  useSettings,
} from "../context/SettingsContext";
import { useAuth } from "../context/AuthContext";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { usePwaTargetDevice } from "../hooks/usePwaTargetDevice";
import {
  canSendAuthenticatedRequest,
  getApiBaseUrl,
  getPasskeyStatus,
  getSharedImportFormatProfiles,
  getAuthMe,
  getBillingSubscriptionStatus,
  getBillingStripeStatus,
  isStripeCheckoutUiReady,
  normalizeAuthContextUser,
  postBillingCheckoutSession,
  postBillingPortalSession,
  postDeleteAccount,
  reclassifyUncategorizedReceipts,
  createSharedImportFormatProfile,
  updateSharedImportFormatProfile,
  deleteSharedImportFormatProfile,
  type SharedImportFormatProfile,
} from "../lib/api";
import { isSubscriptionServiceSubscribedClient } from "../lib/subscriptionAccess";
import {
  formatPremiumSubscriptionPrimaryStatus,
  formatSettingsSubscriptionSummary,
} from "../lib/subscriptionStatusUi";
import {
  formatSubscriptionPeriodEndJaLong,
  formatSubscriptionPeriodEndSlashJst,
  SUBSCRIPTION_PERIOD_END_PENDING_JA,
} from "../lib/subscriptionPeriodEndFormat";
import {
  clearPwaInstallBannerHidden,
  isPwaInstallBannerHidden,
  setPwaInstallBannerHidden,
  subscribePwaInstallPrefs,
} from "../lib/pwaInstallPrefs";
import styles from "../components/KakeiboDashboard.module.css";
import { FeatureGate } from "../components/FeatureGate";
import { FEATURE_MEDICAL_DEDUCTION_CSV } from "../lib/api";
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
  const [pwaGuideImageError, setPwaGuideImageError] = useState(false);
  useEffect(() => subscribePwaInstallPrefs(() => setPwaBannerHidden(isPwaInstallBannerHidden())), []);

  useEffect(() => {
    const h = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (location.pathname !== "/settings") return;
    if (h !== "pwa-install-help" && h !== "fixed-cost-settings") return;

    const tryScroll = () => {
      const el = document.getElementById(h);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        return true;
      }
      return false;
    };

    const raf = requestAnimationFrame(tryScroll);
    const t0 = window.setTimeout(tryScroll, 0);
    const t1 = window.setTimeout(tryScroll, 100);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t0);
      window.clearTimeout(t1);
    };
  }, [location.hash, location.pathname]);

  const { token, user: authUser, setUser, logout } = useAuth();
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
  const [fixedSaveBusy, setFixedSaveBusy] = useState(false);
  const [fixedSaveMessage, setFixedSaveMessage] = useState<string | null>(null);
  const premiumPurchaseUrl = String(
    import.meta.env.VITE_PREMIUM_PURCHASE_URL ?? "",
  ).trim();
  /** 本番でも既定で Checkout を表示。無効化するときのみ VITE_STRIPE_CHECKOUT=0 */
  const stripeCheckoutDisabled =
    String(import.meta.env.VITE_STRIPE_CHECKOUT ?? "").trim() === "0";
  const stripeCheckoutEnabled = import.meta.env.DEV || !stripeCheckoutDisabled;
  const [stripeCheckoutBusy, setStripeCheckoutBusy] = useState(false);
  const [stripeCheckoutMessage, setStripeCheckoutMessage] = useState<string | null>(null);
  /** null: 未確認 / true: サーバーで Price ID と秘密鍵が揃っている */
  const [stripeCheckoutReady, setStripeCheckoutReady] = useState<boolean | null>(null);
  const [billingStatus, setBillingStatus] = useState<{
    subscriptionStatus: string;
    subscriptionPeriodEndAt: string | null;
    subscriptionCancelAtPeriodEnd: boolean;
  } | null>(null);
  const [premiumContractOpen, setPremiumContractOpen] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalMessage, setPortalMessage] = useState<string | null>(null);
  const [passkeyStatus, setPasskeyStatus] = useState<{
    authMethod: string;
    passkeyCount: number;
    hasPasskey: boolean;
    canAnonymize: boolean;
  } | null>(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteAck, setDeleteAck] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importFormats, setImportFormats] = useState<SharedImportFormatProfile[]>([]);
  const [importFormatsBusy, setImportFormatsBusy] = useState(false);
  const [importFormatsMsg, setImportFormatsMsg] = useState<string | null>(null);
  const [importFormatsErr, setImportFormatsErr] = useState<string | null>(null);
  const [editingFormatId, setEditingFormatId] = useState<number | null>(null);
  const [formatName, setFormatName] = useState("");
  const [formatSourceHint, setFormatSourceHint] = useState("");
  const [formatDateHeaders, setFormatDateHeaders] = useState("");
  const [formatDescriptionHeaders, setFormatDescriptionHeaders] = useState("");
  const [formatDescriptionSecondaryHeaders, setFormatDescriptionSecondaryHeaders] = useState("");
  const [formatAmountHeaders, setFormatAmountHeaders] = useState("");
  const [importFormatsExpanded, setImportFormatsExpanded] = useState(false);

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

  const loadImportFormats = async () => {
    setImportFormatsBusy(true);
    setImportFormatsErr(null);
    try {
      const r = await getSharedImportFormatProfiles();
      setImportFormats(Array.isArray(r.items) ? r.items : []);
    } catch (e) {
      setImportFormatsErr(e instanceof Error ? e.message : "取込フォーマットの取得に失敗しました");
    } finally {
      setImportFormatsBusy(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    void loadImportFormats();
  }, [token]);

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const checkoutSuccess = sp.get("checkout") === "success";
    const portalReturn = sp.get("portal") === "return";
    if ((!checkoutSuccess && !portalReturn) || !token) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const maxWaitMs = checkoutSuccess ? 90_000 : 10_000;

    const run = async () => {
      try {
        const res = await getAuthMe();
        const normalized = res?.user ? normalizeAuthContextUser(res.user) : null;
        if (cancelled) return;
        if (normalized) setUser(normalized);
        setPremiumContractOpen(false);
        if (isSubscriptionServiceSubscribedClient(normalized)) return;
      } catch {
        if (cancelled) return;
      }
      if (Date.now() - startedAt >= maxWaitMs || cancelled) return;
      timer = setTimeout(() => {
        void run();
      }, 3000);
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [location.search, token, setUser]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const maxWaitMs = 30_000;

    const refresh = async () => {
      try {
        const res = await getAuthMe();
        const normalized = res?.user ? normalizeAuthContextUser(res.user) : null;
        if (cancelled) return;
        if (normalized) setUser(normalized);
        if (isSubscriptionServiceSubscribedClient(normalized)) return;
      } catch {
        if (cancelled) return;
      }
      if (Date.now() - startedAt >= maxWaitMs || cancelled) return;
      timer = setTimeout(() => {
        void refresh();
      }, 3000);
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, location.pathname, setUser]);

  useEffect(() => {
    if (!token) return;
    if (!canSendAuthenticatedRequest(token)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const maxWaitMs = 45_000;

    const run = async () => {
      try {
        const s = await getBillingSubscriptionStatus();
        if (cancelled) return;
        setBillingStatus(s);
        if (isSubscriptionServiceSubscribedClient(s)) return;
      } catch {
        if (cancelled) return;
      }
      if (Date.now() - startedAt >= maxWaitMs || cancelled) return;
      timer = setTimeout(() => {
        void run();
      }, 3000);
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, location.pathname]);

  useEffect(() => {
    if (!token || !canSendAuthenticatedRequest(token)) {
      setPasskeyStatus(null);
      return;
    }
    let cancelled = false;
    void getPasskeyStatus()
      .then((s) => {
        if (!cancelled) setPasskeyStatus(s);
      })
      .catch(() => {
        if (!cancelled) setPasskeyStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, location.pathname]);

  const effectiveUser = useMemo(() => {
    if (!authUser) return null;
    if (!billingStatus) return authUser;
    return {
      ...authUser,
      subscriptionStatus: billingStatus.subscriptionStatus ?? authUser.subscriptionStatus,
      subscriptionPeriodEndAt:
        billingStatus.subscriptionPeriodEndAt ?? authUser.subscriptionPeriodEndAt ?? null,
      subscriptionCancelAtPeriodEnd:
        billingStatus.subscriptionCancelAtPeriodEnd ??
        authUser.subscriptionCancelAtPeriodEnd ??
        false,
    };
  }, [authUser, billingStatus]);

  const premiumSubscriptionPrimaryLine = useMemo(
    () =>
      effectiveUser ? formatPremiumSubscriptionPrimaryStatus(effectiveUser).trim() : "",
    [effectiveUser],
  );
  const premiumSubscriptionSummaryLine = useMemo(
    () =>
      effectiveUser ? formatSettingsSubscriptionSummary(effectiveUser).trim() : "",
    [effectiveUser],
  );
  const cancelAtPeriodEndNote = useMemo(() => {
    if (!effectiveUser?.subscriptionCancelAtPeriodEnd) return null;
    const endLabel = formatSubscriptionPeriodEndJaLong(effectiveUser.subscriptionPeriodEndAt ?? null);
    if (!endLabel) {
      return `当月末解約の予定です。終了日は${SUBSCRIPTION_PERIOD_END_PENDING_JA}です。請求期間の終了まではプレミアムをご利用いただけます。`;
    }
    return `当月末解約の予定です。プレミアムは ${endLabel} まで（請求期間の終了日基準）ご利用いただけます。`;
  }, [effectiveUser]);

  const premiumCancelInfo = useMemo(() => {
    const user = effectiveUser;
    if (!user) return null;
    const status = String(user.subscriptionStatus ?? "").trim().toLowerCase();
    const periodEnd = formatSubscriptionPeriodEndSlashJst(user.subscriptionPeriodEndAt ?? null);
    const cancelReserved = user.subscriptionCancelAtPeriodEnd === true;
    const canceled = status === "canceled" || status === "cancelled";

    if (!cancelReserved && !canceled) return null;

    if (canceled) {
      if (!periodEnd) {
        return `ℹ 解約済み（有効期限：${SUBSCRIPTION_PERIOD_END_PENDING_JA}。Stripe のサブスクリプション画面で日付をご確認ください）`;
      }
      return `ℹ 解約済み（有効期限：${periodEnd} まで引き続き利用可能でした）`;
    }
    if (cancelReserved && !periodEnd) {
      return `ℹ 解約手続き済み（有効期限：${SUBSCRIPTION_PERIOD_END_PENDING_JA}。反映まで数分かかる場合があります）`;
    }
    return `ℹ 解約手続き済み（有効期限：${periodEnd} まで）`;
  }, [effectiveUser]);

  const premiumPeriodInfo = useMemo(() => {
    const end = formatSubscriptionPeriodEndSlashJst(effectiveUser?.subscriptionPeriodEndAt ?? null);
    if (!end) return null;
    return `ℹ 有効期限：${end} まで`;
  }, [effectiveUser?.subscriptionPeriodEndAt]);

  useEffect(() => {
    if (!premiumContractOpen || !getApiBaseUrl()) return;
    if (!canSendAuthenticatedRequest(token)) return;
    setStripeCheckoutReady(null);
    let cancelled = false;
    void getBillingStripeStatus()
      .then((r) => {
        if (!cancelled) {
          setStripeCheckoutReady(isStripeCheckoutUiReady(r));
          console.log("Stripe Config received:", {
            checkoutReady: r.checkoutReady,
            priceIdConfigured: r.priceIdConfigured,
            secretKeyConfigured: r.secretKeyConfigured,
            uiReady: isStripeCheckoutUiReady(r),
          });
        }
      })
      .catch((err) => {
        console.warn("Stripe config fetch failed:", err);
        /* ステータス取得に失敗しても Checkout 自体は試せるようにする */
        if (!cancelled) setStripeCheckoutReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [premiumContractOpen, token]);

  const parseHeaderCsvInput = (raw: string): string[] =>
    String(raw ?? "")
      .split(/[,\n、]/)
      .map((x) => x.trim())
      .filter(Boolean);

  const resetImportFormatForm = () => {
    setEditingFormatId(null);
    setFormatName("");
    setFormatSourceHint("");
    setFormatDateHeaders("");
    setFormatDescriptionHeaders("");
    setFormatDescriptionSecondaryHeaders("");
    setFormatAmountHeaders("");
  };

  const startEditImportFormat = (row: SharedImportFormatProfile) => {
    setEditingFormatId(Number(row.id));
    setFormatName(String(row.name ?? ""));
    setFormatSourceHint(String(row.sourceHint ?? ""));
    setFormatDateHeaders((row.dateHeaders ?? []).join(", "));
    setFormatDescriptionHeaders((row.descriptionHeaders ?? []).join(", "));
    setFormatDescriptionSecondaryHeaders((row.descriptionSecondaryHeaders ?? []).join(", "));
    setFormatAmountHeaders((row.amountHeaders ?? []).join(", "));
    setImportFormatsMsg(null);
    setImportFormatsErr(null);
  };

  const saveImportFormat = async () => {
    setImportFormatsErr(null);
    setImportFormatsMsg(null);
    const payload = {
      name: formatName.trim(),
      sourceHint: formatSourceHint.trim() || null,
      dateHeaders: parseHeaderCsvInput(formatDateHeaders),
      descriptionHeaders: parseHeaderCsvInput(formatDescriptionHeaders),
      descriptionSecondaryHeaders: parseHeaderCsvInput(formatDescriptionSecondaryHeaders),
      amountHeaders: parseHeaderCsvInput(formatAmountHeaders),
    };
    if (
      !payload.name ||
      payload.dateHeaders.length === 0 ||
      payload.descriptionHeaders.length === 0 ||
      payload.amountHeaders.length === 0
    ) {
      setImportFormatsErr("名称・日付ヘッダ・内容ヘッダ・金額ヘッダを入力してください。");
      return;
    }
    setImportFormatsBusy(true);
    try {
      if (editingFormatId != null) {
        await updateSharedImportFormatProfile(editingFormatId, payload);
        setImportFormatsMsg("フォーマットを更新しました。");
      } else {
        await createSharedImportFormatProfile(payload);
        setImportFormatsMsg("フォーマットを追加しました。");
      }
      resetImportFormatForm();
      await loadImportFormats();
    } catch (e) {
      setImportFormatsErr(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setImportFormatsBusy(false);
    }
  };

  const removeImportFormat = async (id: number) => {
    if (!window.confirm("この取込フォーマットを削除しますか？")) return;
    setImportFormatsBusy(true);
    setImportFormatsErr(null);
    setImportFormatsMsg(null);
    try {
      await deleteSharedImportFormatProfile(id);
      if (editingFormatId === id) resetImportFormatForm();
      setImportFormatsMsg("フォーマットを削除しました。");
      await loadImportFormats();
    } catch (e) {
      setImportFormatsErr(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setImportFormatsBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>設定</h1>

      <FeatureGate feature={FEATURE_MEDICAL_DEDUCTION_CSV} mode="hide">
        <section
          className={styles.settingsPanel}
          style={{
            marginBottom: "1rem",
            border: "2px solid #0ea5e9",
            maxWidth: "min(100%, 52rem)",
          }}
        >
          <h2 className={styles.sectionTitle} style={{ marginTop: 0, marginBottom: "0.45rem" }}>
            医療費控除
          </h2>
          <div className={styles.medicalDeductionRow}>
            <p className={styles.sub}>
              年間分を集計し、申告用CSV（国税庁フォーム互換）を出力します。
            </p>
            <div className={styles.medicalDeductionButtonWrap}>
              <Link to="/medical-deduction" className={`${styles.btn} ${styles.btnPrimary}`}>
                医療費集計へ
              </Link>
            </div>
          </div>
        </section>
      </FeatureGate>
      <details className={styles.settingsPanel} style={{ marginTop: "0.75rem", maxWidth: 980 }} open>
        <summary className={styles.sectionTitle} style={{ cursor: "pointer" }}>
          家族・利用ユーザー
        </summary>
        <p className={styles.reclassifyHint}>
          子供プロフィールを親アカウント内に追加できます。メール招待は使いません。
        </p>
        <MembersPage embedded />
      </details>
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

      <div className={styles.settingsPanel} style={{ marginTop: "1.25rem", maxWidth: 980 }}>
        <h2 className={styles.sectionTitle}>おまかせ取込フォーマット設定（全ユーザ共通）</h2>
        <p className={styles.reclassifyHint} style={{ marginTop: "0.2rem" }}>
          銀行・カード会社CSVのヘッダー名を登録できます。追加・更新は全ユーザ可能、削除は管理者のみです。
        </p>
        {importFormatsMsg ? (
          <p className={styles.reclassifyHint} style={{ color: "var(--success, #166534)", marginTop: "0.45rem" }}>
            {importFormatsMsg}
          </p>
        ) : null}
        {importFormatsErr ? (
          <p className={styles.reclassifyHint} style={{ color: "var(--danger, #b91c1c)", marginTop: "0.45rem" }}>
            {importFormatsErr}
          </p>
        ) : null}
        <div className={styles.modeRow} style={{ marginTop: "0.65rem", gap: "0.45rem", flexWrap: "wrap" }}>
          <input
            className={styles.cellInput}
            placeholder="フォーマット名（例: ○○カード）"
            value={formatName}
            onChange={(e) => setFormatName(e.target.value)}
            style={{ minWidth: "14rem", flex: "1 1 14rem" }}
          />
          <input
            className={styles.cellInput}
            placeholder="ソース判定キーワード（任意）"
            value={formatSourceHint}
            onChange={(e) => setFormatSourceHint(e.target.value)}
            style={{ minWidth: "14rem", flex: "1 1 14rem" }}
          />
        </div>
        <div className={styles.modeRow} style={{ marginTop: "0.45rem", gap: "0.45rem", flexWrap: "wrap" }}>
          <input
            className={styles.cellInput}
            placeholder="日付ヘッダ（カンマ区切り）"
            value={formatDateHeaders}
            onChange={(e) => setFormatDateHeaders(e.target.value)}
            style={{ minWidth: "18rem", flex: "1 1 18rem" }}
          />
          <input
            className={styles.cellInput}
            placeholder="内容ヘッダ（カンマ区切り）"
            value={formatDescriptionHeaders}
            onChange={(e) => setFormatDescriptionHeaders(e.target.value)}
            style={{ minWidth: "18rem", flex: "1 1 18rem" }}
          />
        </div>
        <div className={styles.modeRow} style={{ marginTop: "0.45rem", gap: "0.45rem", flexWrap: "wrap" }}>
          <input
            className={styles.cellInput}
            placeholder="補助内容ヘッダ（任意）"
            value={formatDescriptionSecondaryHeaders}
            onChange={(e) => setFormatDescriptionSecondaryHeaders(e.target.value)}
            style={{ minWidth: "18rem", flex: "1 1 18rem" }}
          />
          <input
            className={styles.cellInput}
            placeholder="金額ヘッダ（カンマ区切り）"
            value={formatAmountHeaders}
            onChange={(e) => setFormatAmountHeaders(e.target.value)}
            style={{ minWidth: "18rem", flex: "1 1 18rem" }}
          />
        </div>
        <div className={styles.modeRow} style={{ marginTop: "0.55rem", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={importFormatsBusy} onClick={() => void saveImportFormat()}>
            {importFormatsBusy ? "保存中…" : editingFormatId != null ? "更新する" : "追加する"}
          </button>
          {editingFormatId != null ? (
            <button type="button" className={styles.btn} disabled={importFormatsBusy} onClick={resetImportFormatForm}>
              編集をキャンセル
            </button>
          ) : null}
          <button type="button" className={styles.btn} disabled={importFormatsBusy} onClick={() => void loadImportFormats()}>
            再読込
          </button>
        </div>
        <div style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => setImportFormatsExpanded((v) => !v)}
            disabled={importFormatsBusy}
          >
            {importFormatsExpanded ? "登録済一覧を閉じる" : `登録済一覧を開く（${importFormats.length}件）`}
          </button>
          {importFormatsExpanded ? (
            <div style={{ marginTop: "0.55rem", display: "grid", gap: "0.45rem" }}>
              {importFormats.map((f) => (
                <div
                  key={f.id}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "0.55rem 0.65rem",
                    background: "var(--panel-bg)",
                  }}
                >
                  <div className={styles.modeRow} style={{ justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                    <strong>{f.name}</strong>
                    <div className={styles.modeRow} style={{ gap: "0.35rem", flexWrap: "wrap" }}>
                      <button type="button" className={styles.btn} disabled={importFormatsBusy} onClick={() => startEditImportFormat(f)}>
                        編集
                      </button>
                      {authUser?.isAdmin ? (
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={importFormatsBusy}
                          onClick={() => void removeImportFormat(f.id)}
                        >
                          削除
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <p className={styles.reclassifyHint} style={{ margin: "0.3rem 0 0" }}>
                    日付: {(f.dateHeaders ?? []).join(" / ")} ｜ 内容: {(f.descriptionHeaders ?? []).join(" / ")} ｜ 金額: {(f.amountHeaders ?? []).join(" / ")}
                  </p>
                </div>
              ))}
              {importFormats.length === 0 && !importFormatsBusy ? (
                <p className={styles.reclassifyHint}>登録済フォーマットはありません。</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.settingsPanel} style={{ marginTop: "1.25rem", maxWidth: 820 }}>
        <h2 className={styles.sectionTitle}>メインメニュー</h2>
        <p
          className={styles.sub}
          style={{ margin: "0.4rem 0 0.25rem", fontSize: "0.9rem", lineHeight: 1.65 }}
        >
          本アプリのメイン導線は、テキスト中心のガラス風ミニマルナビ（スマートフォンは画面下部、PC
          は上部）に統一しています。従来の画像によるアイコン着せ替え（スタンダード／フルーツ等）は廃止しました。プレミアム会員向けのレシート取込等の特典は、契約状況に従い従来どおり利用できます。
        </p>
        {token && effectiveUser ? (
          <div className={styles.sub} style={{ margin: "0.65rem 0 0", fontSize: "0.85rem" }}>
            <p style={{ margin: 0, fontWeight: 600 }}>プレミアム（サブスクリプション）</p>
            <div
              className={styles.modeRow}
              style={{
                marginTop: "0.35rem",
                flexWrap: "wrap",
                gap: "0.5rem",
                alignItems: "center",
                justifyContent: "flex-start",
              }}
            >
              {premiumSubscriptionPrimaryLine ? (
                <span style={{ fontWeight: 600 }}>{premiumSubscriptionPrimaryLine}</span>
              ) : null}
              {isSubscriptionServiceSubscribedClient(effectiveUser) &&
              getApiBaseUrl() &&
              canSendAuthenticatedRequest(token) ? (
                <>
                  {!premiumCancelInfo ? (
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={portalBusy}
                      onClick={async () => {
                        setPortalMessage(null);
                        setPortalBusy(true);
                        try {
                          const base =
                            typeof window !== "undefined"
                              ? `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "") || ""}`
                              : "";
                          const { url } = await postBillingPortalSession({
                            returnUrl: `${base}/settings?portal=return`,
                          });
                          window.location.assign(url);
                        } catch (e) {
                          setPortalMessage(e instanceof Error ? e.message : String(e));
                        } finally {
                          setPortalBusy(false);
                        }
                      }}
                    >
                      {portalBusy ? "準備中…" : "解約（プラン管理）"}
                    </button>
                  ) : null}
                  {premiumCancelInfo ? (
                    <span
                      style={{
                        color: "var(--text-muted)",
                        fontSize: "0.82rem",
                        fontWeight: 500,
                      }}
                    >
                      {premiumCancelInfo}
                    </span>
                  ) : null}
                  {!premiumCancelInfo && premiumPeriodInfo ? (
                    <span
                      style={{
                        color: "var(--text-muted)",
                        fontSize: "0.82rem",
                        fontWeight: 500,
                      }}
                    >
                      {premiumPeriodInfo}
                    </span>
                  ) : null}
                  {cancelAtPeriodEndNote && !premiumCancelInfo ? (
                    <span style={{ color: "#8b1f1f", fontSize: "0.82rem", fontWeight: 600 }}>
                      {cancelAtPeriodEndNote}
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
            {premiumSubscriptionSummaryLine ? (
              <p className={styles.reclassifyHint} style={{ margin: "0.35rem 0 0" }}>
                {premiumSubscriptionSummaryLine}
              </p>
            ) : null}
            {portalMessage ? (
              <p className={styles.reclassifyHint} style={{ margin: "0.35rem 0 0" }}>
                {portalMessage}
              </p>
            ) : null}
            {premiumContractOpen &&
            stripeCheckoutEnabled &&
            getApiBaseUrl() &&
            canSendAuthenticatedRequest(token) ? (
              <div
                className={styles.settingsPanel}
                style={{
                  marginTop: "0.5rem",
                  padding: "0.75rem",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "var(--panel-bg)",
                }}
              >
                <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>プレミアム契約</p>
                <p className={styles.reclassifyHint} style={{ margin: "0 0 0.65rem" }}>
                  Stripe でサブスクリプションに申し込むと、レシート取込等のプレミアム機能をご利用いただけます。解約はいつでも可能で、
                  <strong> 請求期間の終了日までは利用を継続</strong>できます（Stripe の請求サイクルに準じます）。
                </p>
                {stripeCheckoutReady === null ? (
                  <p className={styles.reclassifyHint} style={{ margin: "0 0 0.5rem" }}>
                    決済設定を確認しています…
                  </p>
                ) : null}
                {stripeCheckoutReady === false ? (
                  <p className={styles.reclassifyHint} style={{ margin: "0 0 0.65rem" }}>
                    サーバー側の決済設定が未完了です。API ホストにサブスク用の Price ID（例:{" "}
                    <code>STRIPE_TEST_PRICE_ID</code>）と Stripe 秘密鍵が読み込まれているか確認してください。プロジェクトルートで{" "}
                    <code>npm run dev</code> を使う場合は <code>backend/.env</code> に記載し、Vite 経由なら{" "}
                    <code>API_PATH_PREFIX=/api</code> も必要です。
                  </p>
                ) : null}
                <div className={styles.modeRow} style={{ flexWrap: "wrap", gap: "0.4rem" }}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={
                      stripeCheckoutBusy || stripeCheckoutReady === false || stripeCheckoutReady === null
                    }
                    onClick={async () => {
                      setStripeCheckoutMessage(null);
                      setStripeCheckoutBusy(true);
                      try {
                        const base =
                          typeof window !== "undefined"
                            ? `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "") || ""}`
                            : "";
                        const { url } = await postBillingCheckoutSession({
                          successUrl: `${base}/settings?checkout=success`,
                          cancelUrl: `${base}/settings?checkout=cancel`,
                        });
                        window.location.assign(url);
                      } catch (e) {
                        const raw = e instanceof Error ? e.message : String(e);
                        const isServerConfig =
                          /STRIPE_|設定してください|StripeCheckoutUnavailable|決済設定/i.test(raw);
                        setStripeCheckoutMessage(
                          isServerConfig
                            ? "サーバーに決済用の環境変数が読み込まれていない可能性があります。API を再起動し、backend/.env の STRIPE_TEST_PRICE_ID（または STRIPE_PRICE_ID）と Stripe 秘密鍵、必要なら API_PATH_PREFIX=/api を確認してください。"
                            : raw,
                        );
                      } finally {
                        setStripeCheckoutBusy(false);
                      }
                    }}
                  >
                    {stripeCheckoutBusy
                      ? "準備中…"
                      : stripeCheckoutReady === null
                        ? "確認中…"
                        : "契約する（Stripe Checkout）"}
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setPremiumContractOpen(false)}
                  >
                    閉じる
                  </button>
                </div>
                {stripeCheckoutMessage ? (
                  <p className={styles.reclassifyHint} style={{ margin: "0.35rem 0 0" }}>
                    {stripeCheckoutMessage}
                  </p>
                ) : null}
                {import.meta.env.DEV ? (
                  <p className={styles.reclassifyHint} style={{ margin: "0.35rem 0 0" }}>
                    テストカード例: 4242 4242 4242 4242。ローカルで{" "}
                    <code>stripe listen</code> 中は <code>whsec_...</code> を{" "}
                    <code>STRIPE_WEBHOOK_SECRET</code> に合わせてください。
                  </p>
                ) : null}
              </div>
            ) : null}
            {premiumPurchaseUrl ? (
              <p style={{ margin: "0.45rem 0 0" }}>
                <a href={premiumPurchaseUrl} target="_blank" rel="noopener noreferrer">
                  プレミアムの案内・お申し込み（外部サイト）
                </a>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <details
        id="fixed-cost-settings"
        className={styles.settingsPanel}
        style={{ marginTop: "1.5rem", maxWidth: 720 }}
        open
      >
        <summary className={styles.sectionTitle} style={{ cursor: "pointer" }}>
          固定費設定（全月共通）
        </summary>
        <p className={styles.reclassifyHint}>固定費を登録。毎月の集計に自動反映。</p>
        {!getApiBaseUrl() || !canSendAuthenticatedRequest(token) ? (
          <p className={styles.reclassifyHint}>
            API に接続できない、またはログイン・開発用ユーザー設定がない場合は、この端末の画面にのみ反映されます。
          </p>
        ) : null}
        <div className={styles.form} style={{ marginTop: "0.5rem" }}>
          <div className={styles.field} style={{ gridColumn: "1 / -1" }}>
            <label>固定費入力（1行 = カテゴリ + 金額 / カテゴリは自由入力）</label>
            <div style={{ display: "grid", gap: 8 }}>
              {fixedItems.map((item, idx) => (
                <div key={item.id} className={styles.fixedCostRow}>
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
          <div className={styles.settingsFixedCostFormActions}>
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
        </div>
        {fixedSaveMessage ? (
          <p className={styles.infoText}>{fixedSaveMessage}</p>
        ) : null}
        <p className={styles.infoText}>固定費合計: ¥{fixedCostTotal.toLocaleString("ja-JP")}</p>
      </details>

      <div
        id="pwa-install-help"
        className={styles.settingsPanel}
        style={{ marginTop: "1.5rem", maxWidth: 720 }}
      >
        <h2 className={styles.sectionTitle}>ホーム画面に追加（アプリのように使う）</h2>
        {!pwaGuideImageError ? (
          <img
            src={`${import.meta.env.BASE_URL}pwa-install-guide.png`}
            alt="ホーム画面への追加手順"
            loading="lazy"
            onError={() => setPwaGuideImageError(true)}
            style={{
              width: "100%",
              maxWidth: 620,
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "#fff",
              display: "block",
              margin: "0.25rem auto 0.35rem",
            }}
          />
        ) : (
          <p className={styles.reclassifyHint} style={{ marginTop: "0.3rem" }}>
            ガイド画像を読み込めませんでした。再読み込みしても表示されない場合は、管理者にお問い合わせください。
          </p>
        )}
        {!pwaTarget ? (
          <p className={styles.reclassifyHint} style={{ marginTop: "0.4rem" }}>
            この端末ではインストール案内バーの対象外ですが、手順ガイドは参照できます。
          </p>
        ) : null}
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

      <details className={styles.settingsPanel} style={{ marginTop: "1.5rem", maxWidth: 980 }} open>
        <summary className={styles.sectionTitle} style={{ cursor: "pointer" }}>
          支出・収入（カテゴリ管理）
        </summary>
        <p className={styles.reclassifyHint}>
          支出・収入のカテゴリを追加・変更・削除できます。
        </p>
        <CategoriesPage embedded />
      </details>

      <div
        className={`${styles.settingsPanel} ${styles.reclassifySettingsPanel}`}
        style={{ marginTop: "1.5rem", maxWidth: 720 }}
      >
        <h2 className={styles.sectionTitle} style={{ marginBottom: "0.45rem" }}>
          レシート自動再分類
        </h2>
        <div className={styles.reclassifySettingsLayout}>
          <p className={styles.reclassifyHint}>
            全期間の未分類を再分類（件数により時間変動）します
          </p>
          <div className={styles.reclassifySettingsButtonWrap}>
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
          </div>
        </div>
        {reclassifyResult ? (
          <p className={styles.infoText} style={{ marginTop: "0.5rem", marginBottom: 0 }}>
            {reclassifyResult}
          </p>
        ) : null}
      </div>

      {token && authUser && !authUser.isChild && !authUser.isAdmin ? (
        <div
          className={styles.settingsPanel}
          style={{
            marginTop: "1.75rem",
            maxWidth: 720,
            borderColor: "color-mix(in oklab, #dc2626 35%, var(--border) 65%)",
          }}
        >
          <h2 className={styles.sectionTitle} style={{ color: "#b91c1c" }}>
            退会（アカウント削除）
          </h2>
          <p className={styles.reclassifyHint}>
            アカウントと家計簿データをサーバーから完全に削除します。取り消しはできません。
          </p>
          <button
            type="button"
            className={styles.btn}
            style={{
              borderColor: "color-mix(in oklab, #dc2626 45%, var(--border) 55%)",
              color: "#b91c1c",
              fontWeight: 700,
            }}
            onClick={() => {
              setDeleteError(null);
              setDeletePassword("");
              setDeleteAck("");
              setDeleteAccountOpen(true);
            }}
          >
            退会する
          </button>
        </div>
      ) : null}

      {deleteAccountOpen && authUser && !authUser.isAdmin ? (
        <div
          className={styles.deleteAccountBackdrop}
          role="presentation"
          onClick={() => {
            if (!deleteBusy) setDeleteAccountOpen(false);
          }}
        >
          <div
            className={styles.deleteAccountDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="delete-account-title" className={styles.sectionTitle} style={{ color: "#b91c1c" }}>
              最終確認
            </h2>
            <p className={styles.reclassifyHint} style={{ marginTop: 0 }}>
              退会すると家計簿データはすべて消去され、プレミアムプランに加入している場合は
              <strong> Stripe の定期課金は即時解約</strong>されます（残り日数の返金は各規約に従います）。この操作は
              <strong>取り消せません</strong>。
            </p>
            {String(passkeyStatus?.authMethod ?? "")
              .toLowerCase()
              .trim() === "passkey" ? (
              <label className={styles.settingsLabel} style={{ display: "block", marginTop: "0.75rem" }}>
                パスキー登録のみの方: 下記を{" "}
                <strong>一字違いなく</strong> 入力してください
                <input
                  type="text"
                  className={styles.monthInput}
                  style={{ width: "100%", marginTop: "0.35rem", maxWidth: "100%" }}
                  value={deleteAck}
                  onChange={(e) => setDeleteAck(e.target.value)}
                  autoComplete="off"
                  disabled={deleteBusy}
                  placeholder="KAKEIBO_PERMANENT_DELETE"
                />
              </label>
            ) : (
              <label className={styles.settingsLabel} style={{ display: "block", marginTop: "0.75rem" }}>
                現在のパスワード
                <input
                  type="password"
                  className={styles.monthInput}
                  style={{ width: "100%", marginTop: "0.35rem", maxWidth: "100%" }}
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={deleteBusy}
                />
              </label>
            )}
            {deleteError ? (
              <p className={styles.errorText} style={{ marginTop: "0.6rem" }}>
                {deleteError}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className={styles.btn}
                disabled={deleteBusy}
                onClick={() => setDeleteAccountOpen(false)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className={styles.btn}
                style={{ borderColor: "#b91c1c", color: "#fff", background: "#b91c1c", fontWeight: 800 }}
                disabled={deleteBusy}
                onClick={async () => {
                  setDeleteError(null);
                  setDeleteBusy(true);
                  try {
                    const passkeyOnly =
                      String(passkeyStatus?.authMethod ?? "")
                        .toLowerCase()
                        .trim() === "passkey";
                    await postDeleteAccount(
                      passkeyOnly
                        ? { acknowledge: deleteAck.trim() }
                        : { password: deletePassword },
                    );
                    setDeleteAccountOpen(false);
                    logout();
                    const path = import.meta.env.BASE_URL || "/";
                    window.location.href = new URL(
                      path,
                      window.location.origin,
                    ).href;
                  } catch (e) {
                    setDeleteError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setDeleteBusy(false);
                  }
                }}
              >
                {deleteBusy ? "処理中…" : "退会を実行する"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
