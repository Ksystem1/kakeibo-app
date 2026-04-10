import { useCallback, useEffect, useState } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { getAuthMe, normalizeAuthContextUser } from "../lib/api";
import { AdSlot } from "./AdSlot";
import { AiAdvisorChat } from "./AiAdvisorChat";
import { MobileAccessQr } from "./MobileAccessQr";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

/** iPhone / iPad（iPadOS のデスクトップ UA 含む）。Android は除外。 */
function isLikelyIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return false;
  return (
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function linkStyle(
  mobile: boolean,
  { isActive }: { isActive: boolean },
) {
  return {
    fontWeight: isActive ? 700 : 600,
    color: isActive ? "var(--text)" : "var(--text-muted)",
    textDecoration: "none",
    padding: mobile ? "0.34rem 0.6rem" : "0.45rem 0.78rem",
    fontSize: mobile ? "0.8rem" : undefined,
    borderRadius: 10,
    border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: isActive ? "var(--accent-dim)" : "var(--bg-card)",
    boxShadow: isActive
      ? "0 3px 8px rgba(22, 108, 182, 0.18)"
      : "0 1px 4px rgba(15, 43, 71, 0.08)",
    whiteSpace: "nowrap" as const,
  };
}

export function AppLayout() {
  const { token, user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [installPromptEvent, setInstallPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [iosPwaHintOpen, setIosPwaHintOpen] = useState(false);

  useEffect(() => {
    const checkInstalled = () => {
      const standalone =
        window.matchMedia?.("(display-mode: standalone)")?.matches === true;
      const iosStandalone =
        (window.navigator as Navigator & { standalone?: boolean })
          .standalone === true;
      setIsInstalled(standalone || iosStandalone);
    };
    checkInstalled();
    window.addEventListener("appinstalled", checkInstalled);
    return () => {
      window.removeEventListener("appinstalled", checkInstalled);
    };
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (ev: Event) => {
      ev.preventDefault();
      setInstallPromptEvent(ev as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    };
  }, []);

  const handleChromiumInstallClick = useCallback(async () => {
    if (!installPromptEvent) return;
    await installPromptEvent.prompt();
    const result = await installPromptEvent.userChoice;
    if (result.outcome === "accepted") {
      setInstallPromptEvent(null);
    }
  }, [installPromptEvent]);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      return () => {
        cancelled = true;
      };
    }
    // トークンがある限りサーバの /auth/me で同期（ログイン直後・リロード・DB の is_admin 変更を確実に反映）
    void getAuthMe()
      .then((res) => {
        if (cancelled || !res?.user) return;
        setUser(normalizeAuthContextUser(res.user));
      })
      .catch(() => {
        /* no-op: オフライン時はログイン応答の user のみ */
      });
    return () => {
      cancelled = true;
    };
  }, [token, setUser]);

  useEffect(() => {
    if (!iosPwaHintOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIosPwaHintOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [iosPwaHintOpen]);

  const showChromiumInstall = mobile && !isInstalled && installPromptEvent != null;
  const showIosAddToHome =
    mobile && !isInstalled && isLikelyIos() && installPromptEvent == null;

  return (
    <>
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          borderBottom: "1px solid var(--border)",
          padding: mobile ? "0.45rem 0.65rem 0.5rem" : "0.5rem 1rem 0.55rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.45rem",
          background: "var(--panel-bg)",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          backdropFilter: "none",
        }}
      >
        {/* 1段目: ブランド + ユーティリティ（横スクロール防止のため flex:1 スペーサーは使わない） */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.45rem",
            width: "100%",
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
              flexShrink: 0,
            }}
          >
            <img
              src={`${import.meta.env.BASE_URL}brand-kakeibo-2.png`}
              alt=""
              aria-hidden="true"
              width={42}
              height={42}
              style={{
                width: mobile ? 34 : 42,
                height: mobile ? 34 : 42,
                borderRadius: 12,
                boxShadow: "0 6px 14px rgba(20, 46, 76, 0.2)",
              }}
            />
            <strong
              style={{
                letterSpacing: "-0.02em",
                lineHeight: 1.2,
                fontSize: mobile ? "1rem" : "1.08rem",
                padding: "0.3rem 0.7rem",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--bg-card)",
                boxShadow: "0 1px 4px rgba(20, 46, 76, 0.12)",
              }}
            >
              🐷 Kakeibo
            </strong>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "0.45rem",
              minWidth: 0,
              flex: "1 1 auto",
            }}
          >
            {!mobile ? <MobileAccessQr fixedPath={`${import.meta.env.BASE_URL}login`} compact /> : null}
            {token ? (
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate("/login", { replace: true });
                }}
                style={{
                  font: "inherit",
                  fontSize: mobile ? "0.8rem" : undefined,
                  cursor: "pointer",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  borderRadius: 8,
                  padding: mobile ? "0.3rem 0.55rem" : "0.35rem 0.75rem",
                  flexShrink: 0,
                  maxWidth: "100%",
                }}
              >
                ログアウト
              </button>
            ) : null}
          </div>
        </div>
        {/* 2段目: ナビゲーション */}
        <nav
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: mobile ? "0.28rem" : "0.35rem",
            width: "100%",
            minWidth: 0,
            paddingTop: "0.4rem",
            borderTop: "1px solid var(--border)",
          }}
          aria-label="メインメニュー"
        >
          {token ? (
            <>
              {showChromiumInstall ? (
                <button
                  type="button"
                  onClick={() => void handleChromiumInstallClick()}
                  style={linkStyle(mobile, { isActive: false })}
                >
                  📲 アプリをインストール
                </button>
              ) : null}
              {showIosAddToHome ? (
                <button
                  type="button"
                  onClick={() => setIosPwaHintOpen(true)}
                  style={linkStyle(mobile, { isActive: false })}
                >
                  📲 ホーム画面に追加
                </button>
              ) : null}
              <NavLink to="/dashboard" style={(p) => linkStyle(mobile, p)}>
                🐷 ダッシュボード
              </NavLink>
              <NavLink to="/" style={(p) => linkStyle(mobile, p)} end>
                🏠 家計簿
              </NavLink>
              {!mobile ? (
                <NavLink to="/import" style={(p) => linkStyle(mobile, p)}>
                  📥 CSV取込（PC）
                </NavLink>
              ) : null}
              <NavLink to="/receipt" style={(p) => linkStyle(mobile, p)}>
                🧾 レシート
              </NavLink>
              <NavLink to="/members" style={(p) => linkStyle(mobile, p)}>
                👨‍👩‍👧‍👦 家族
              </NavLink>
              <NavLink to="/categories" style={(p) => linkStyle(mobile, p)}>
                🗂️ カテゴリ
              </NavLink>
              <NavLink to="/settings" style={(p) => linkStyle(mobile, p)}>
                🎀 設定
              </NavLink>
              {user &&
              (user.isAdmin ||
                user.email.toLowerCase() === "script_00123@yahoo.co.jp") ? (
                <NavLink to="/admin" style={(p) => linkStyle(mobile, p)}>
                  🛠️ 管理
                </NavLink>
              ) : null}
            </>
          ) : (
            <>
              {showChromiumInstall ? (
                <button
                  type="button"
                  onClick={() => void handleChromiumInstallClick()}
                  style={linkStyle(mobile, { isActive: false })}
                >
                  📲 アプリをインストール
                </button>
              ) : null}
              {showIosAddToHome ? (
                <button
                  type="button"
                  onClick={() => setIosPwaHintOpen(true)}
                  style={linkStyle(mobile, { isActive: false })}
                >
                  📲 ホーム画面に追加
                </button>
              ) : null}
              <NavLink to="/login" style={(p) => linkStyle(mobile, p)}>
                🔐 ログイン
              </NavLink>
              <NavLink to="/register" style={(p) => linkStyle(mobile, p)}>
                ✨ 新規登録
              </NavLink>
            </>
          )}
        </nav>
      </header>
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>
      {token ? <AiAdvisorChat /> : null}
      <AdSlot placement="footer" />
    </div>
    {iosPwaHintOpen ? (
      <div
        role="presentation"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 10050,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1rem",
          background: "rgba(15, 43, 71, 0.45)",
          boxSizing: "border-box",
        }}
        onClick={() => setIosPwaHintOpen(false)}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ios-pwa-hint-title"
          style={{
            maxWidth: 440,
            width: "100%",
            background: "var(--bg-card)",
            borderRadius: 12,
            border: "1px solid var(--border)",
            padding: "1.25rem",
            boxShadow: "0 12px 40px rgba(15, 43, 71, 0.22)",
            color: "var(--text)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <h2
            id="ios-pwa-hint-title"
            style={{ margin: "0 0 0.75rem", fontSize: "1.05rem", lineHeight: 1.35 }}
          >
            ホーム画面に追加（iPhone / iPad）
          </h2>
          <ol
            style={{
              margin: "0 0 1rem",
              paddingLeft: "1.25rem",
              lineHeight: 1.65,
              fontSize: "0.95rem",
            }}
          >
            <li>画面下の「共有」ボタンをタップ</li>
            <li>「ホーム画面に追加」を選ぶ</li>
            <li>「追加」をタップして完了</li>
          </ol>
          <p
            style={{
              margin: "0 0 1rem",
              fontSize: "0.88rem",
              lineHeight: 1.55,
              color: "var(--text-muted)",
            }}
          >
            Safari で開いているときの手順です。Chrome など他ブラウザでは共有メニューに同様の項目がある場合があります。
          </p>
          <button
            type="button"
            onClick={() => setIosPwaHintOpen(false)}
            style={{
              font: "inherit",
              fontWeight: 700,
              cursor: "pointer",
              borderRadius: 10,
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "#fff",
              padding: "0.5rem 1.1rem",
            }}
          >
            閉じる
          </button>
        </div>
      </div>
    ) : null}
    </>
  );
}
