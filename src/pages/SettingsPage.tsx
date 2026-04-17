import {
  type FixedCostItem,
  useSettings,
} from "../context/SettingsContext";
import { useAuth } from "../context/AuthContext";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { usePwaTargetDevice } from "../hooks/usePwaTargetDevice";
import {
  DEFAULT_NAV_SKIN_ID,
  PREMIUM_NAV_SKIN_ID,
  buildNavIconPaths,
  firstAvailablePremiumVariantId,
  type NavIconPaths,
} from "../config/navSkins";
import {
  canSendAuthenticatedRequest,
  getApiBaseUrl,
  getAuthMe,
  getBillingSubscriptionStatus,
  getBillingStripeStatus,
  isStripeCheckoutUiReady,
  normalizeAuthContextUser,
  postBillingCheckoutSession,
  postBillingPortalSession,
  reclassifyUncategorizedReceipts,
} from "../lib/api";
import { subscriptionStatusLabelJa } from "../lib/subscriptionStatusLabels";
import { formatSettingsSubscriptionSummary } from "../lib/subscriptionStatusUi";
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

/** Stripe 上で契約が継続しているときのみプラン管理（ポータル）を出す */
function shouldShowSubscriptionManage(user: { subscriptionStatus?: string } | null | undefined): boolean {
  if (!user) return false;
  const s = String(user.subscriptionStatus ?? "").trim().toLowerCase();
  return s === "active" || s === "trialing" || s === "past_due";
}

function hasPremiumStatus(user: { subscriptionStatus?: string } | null | undefined): boolean {
  if (!user) return false;
  const s = String(user.subscriptionStatus ?? "").trim().toLowerCase();
  return s === "active" || s === "trialing" || s === "past_due";
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
    if (location.pathname !== "/settings") return;
    if (h !== "pwa-install-help" && h !== "fixed-cost-settings") return;
    requestAnimationFrame(() => {
      document.getElementById(h)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, [location.hash, location.pathname]);

  const { token, user: authUser, setUser } = useAuth();
  const {
    fontScale,
    setFontScale,
    fontMode,
    setFontMode,
    themeMode,
    setThemeMode,
    fixedCostsByMonth,
    setFixedCostsForMonth,
    navSkinId,
    navSkinOptions,
    navPremiumVariantOptions,
    availableNavSkinIds,
    setNavSkinId,
    premiumNavUnlocked,
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
        if (hasPremiumStatus(normalized)) return;
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
        if (hasPremiumStatus(normalized)) return;
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
        if (hasPremiumStatus({ subscriptionStatus: s.subscriptionStatus })) return;
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

  const subscriptionEndLabel = useMemo(() => {
    const endRaw = effectiveUser?.subscriptionPeriodEndAt;
    if (endRaw == null || String(endRaw).trim() === "") return null;
    const d = new Date(String(endRaw));
    if (!Number.isFinite(d.getTime())) return null;
    const date = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(d);
    if (effectiveUser?.subscriptionCancelAtPeriodEnd) {
      return `利用期限: ${date}`;
    }
    return `請求期間終了: ${date}`;
  }, [effectiveUser]);
  const navPreviewOrder: Array<keyof NavIconPaths> = [
    "dashboard",
    "kakeibo",
    "receipt",
    "csvPc",
    "settings",
    "admin",
  ];
  const defaultNavPreviewIcons = useMemo(
    () => buildNavIconPaths(DEFAULT_NAV_SKIN_ID),
    [],
  );

  /** プレミアム枠プレビュー用（Tmp02〜のうち現在 or 先頭の利用可能フォルダ） */
  const premiumPreviewSkinId = useMemo(() => {
    if (navSkinId !== DEFAULT_NAV_SKIN_ID) return navSkinId;
    return firstAvailablePremiumVariantId(availableNavSkinIds) ?? PREMIUM_NAV_SKIN_ID;
  }, [navSkinId, availableNavSkinIds]);

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
        <div
          className={styles.modeRow}
          style={{ marginTop: "0.5rem", flexWrap: "wrap", gap: "0.4rem" }}
        >
          {navSkinOptions.map((opt) => {
            const locked = !opt.unlocked;
            return (
              <button
                key={opt.id}
                type="button"
                className={`${styles.btn} ${opt.selected ? styles.btnPrimary : ""}`}
                aria-pressed={opt.selected}
                aria-label={
                  locked
                    ? `${opt.label}（タップで契約・プランの案内を表示）`
                    : opt.unlocked
                      ? `${opt.label}に切り替え`
                      : `${opt.label}（未購入のため選択できません）`
                }
                onClick={() => {
                  if (locked && opt.id !== DEFAULT_NAV_SKIN_ID) {
                    setPremiumContractOpen(true);
                    setStripeCheckoutMessage(null);
                    setPortalMessage(null);
                    return;
                  }
                  if (opt.id === PREMIUM_NAV_SKIN_ID) {
                    const first = firstAvailablePremiumVariantId(availableNavSkinIds);
                    void setNavSkinId(first ?? PREMIUM_NAV_SKIN_ID);
                    return;
                  }
                  setNavSkinId(opt.id);
                }}
              >
                {opt.unlocked ? "" : "🔒 "}
                {opt.label}
              </button>
            );
          })}
        </div>
        {premiumNavUnlocked && navPremiumVariantOptions.length > 1 ? (
          <div
            className={styles.modeRow}
            style={{ marginTop: "0.35rem", flexWrap: "wrap", gap: "0.4rem" }}
          >
            {navPremiumVariantOptions.map((v) => {
              const preview = buildNavIconPaths(v.id);
              return (
              <button
                key={v.id}
                type="button"
                className={`${styles.btn} ${v.selected ? styles.btnPrimary : ""}`}
                aria-pressed={v.selected}
                aria-label={`${v.label}のスキンを適用`}
                onClick={() => void setNavSkinId(v.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                <img
                  src={preview.dashboard}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  width={28}
                  height={28}
                  style={{ width: 28, height: 28, borderRadius: 6, objectFit: "contain" }}
                  onError={(ev) => {
                    const img = ev.currentTarget;
                    if (img.dataset.fallbackApplied === "1") return;
                    img.dataset.fallbackApplied = "1";
                    img.src = defaultNavPreviewIcons.dashboard;
                  }}
                />
                {v.label}
              </button>
              );
            })}
          </div>
        ) : null}
        {token && effectiveUser ? (
          <div className={styles.sub} style={{ margin: "0.65rem 0 0", fontSize: "0.85rem" }}>
            <p style={{ margin: 0 }}>
              プレミアム（サブスクリプション）状態:{" "}
              <strong>
                {subscriptionStatusLabelJa(effectiveUser.subscriptionStatus ?? "inactive")}
                {subscriptionEndLabel ? `（${subscriptionEndLabel}）` : ""}
              </strong>
            </p>
            <p className={styles.reclassifyHint} style={{ margin: "0.35rem 0 0" }}>
              {formatSettingsSubscriptionSummary(effectiveUser)}
            </p>
            {shouldShowSubscriptionManage(effectiveUser) &&
            getApiBaseUrl() &&
            canSendAuthenticatedRequest(token) ? (
              <div className={styles.modeRow} style={{ marginTop: "0.45rem", flexWrap: "wrap", gap: "0.4rem" }}>
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
                {portalMessage ? (
                  <p className={styles.reclassifyHint} style={{ margin: 0 }}>
                    {portalMessage}
                  </p>
                ) : null}
              </div>
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
                  Stripe でサブスクリプションに申し込むと、プレミアムナビスキンやレシート関連の機能がご利用いただけます。解約はいつでも可能で、
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
            {stripeCheckoutEnabled &&
            getApiBaseUrl() &&
            canSendAuthenticatedRequest(token) &&
            premiumNavUnlocked &&
            !premiumContractOpen ? (
              <>
                <div className={styles.navSkinPreviewWrap}>
                  {navSkinOptions.map((opt) => {
                    const locked = !opt.unlocked;
                    const iconSet = buildNavIconPaths(
                      opt.id === DEFAULT_NAV_SKIN_ID ? DEFAULT_NAV_SKIN_ID : premiumPreviewSkinId,
                    );
                    return (
                      <button
                        key={`preview-${opt.id}`}
                        type="button"
                        className={`${styles.navSkinPreviewCard}${opt.selected ? ` ${styles.navSkinPreviewCardSelected}` : ""}`}
                        aria-pressed={opt.selected}
                        aria-label={locked ? `${opt.label}（契約案内を表示）` : `${opt.label}を適用`}
                        onClick={() => {
                          if (locked && opt.id !== DEFAULT_NAV_SKIN_ID) {
                            setPremiumContractOpen(true);
                            setStripeCheckoutMessage(null);
                            setPortalMessage(null);
                            return;
                          }
                          if (opt.id === PREMIUM_NAV_SKIN_ID) {
                            const first = firstAvailablePremiumVariantId(availableNavSkinIds);
                            void setNavSkinId(first ?? PREMIUM_NAV_SKIN_ID);
                            return;
                          }
                          setNavSkinId(opt.id);
                        }}
                      >
                        <div className={styles.navSkinPreviewTitleRow}>
                          <span className={styles.navSkinPreviewTitle}>{opt.label}</span>
                          <span className={styles.navSkinPreviewState}>
                            {locked ? "🔒" : opt.selected ? "適用中" : "選択"}
                          </span>
                        </div>
                        <div className={styles.navSkinPreviewIcons}>
                          {navPreviewOrder.map((k) => (
                            <span key={`${opt.id}-${k}`} className={styles.navSkinPreviewIconSlot}>
                              <img
                                src={iconSet[k]}
                                alt=""
                                aria-hidden="true"
                                loading="lazy"
                                onError={(ev) => {
                                  const img = ev.currentTarget;
                                  if (img.dataset.fallbackApplied === "1") return;
                                  img.dataset.fallbackApplied = "1";
                                  img.src = defaultNavPreviewIcons[k];
                                }}
                              />
                            </span>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
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

      <div
        id="fixed-cost-settings"
        className={styles.settingsPanel}
        style={{ marginTop: "1.5rem", maxWidth: 720 }}
      >
        <h2 className={styles.sectionTitle}>固定費設定（全月共通）</h2>
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
