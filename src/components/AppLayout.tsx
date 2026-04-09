import { useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { getAuthMe, normalizeAuthContextUser } from "../lib/api";
import { AdSlot } from "./AdSlot";
import { AiAdvisorChat } from "./AiAdvisorChat";
import { MobileAccessQr } from "./MobileAccessQr";

function linkStyle(
  mobile: boolean,
  { isActive }: { isActive: boolean },
) {
  return {
    fontWeight: isActive ? 800 : 600,
    color: isActive ? "#3a200f" : "var(--text-muted)",
    textDecoration: "none",
    padding: mobile ? "0.34rem 0.6rem" : "0.45rem 0.78rem",
    fontSize: mobile ? "0.8rem" : undefined,
    borderRadius: 999,
    border: isActive ? "1px solid rgba(255, 196, 84, 0.78)" : "1px solid rgba(130, 152, 178, 0.3)",
    background: isActive
      ? "linear-gradient(135deg, #ffe589 0%, #ffd166 50%, #ffb84d 100%)"
      : "linear-gradient(135deg, rgba(255,255,255,0.92) 0%, rgba(241,247,255,0.88) 100%)",
    boxShadow: isActive
      ? "0 6px 14px rgba(255, 179, 60, 0.22)"
      : "0 4px 10px rgba(15, 43, 71, 0.08)",
    whiteSpace: "nowrap" as const,
  };
}

export function AppLayout() {
  const { token, user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const mobile = useIsMobile();

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

  return (
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
          background:
            "linear-gradient(135deg, rgba(255,255,255,0.94) 0%, rgba(236,246,255,0.9) 45%, rgba(255,243,220,0.9) 100%)",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          backdropFilter: "saturate(1.05)",
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
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.58)",
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.88) 0%, rgba(225,245,255,0.72) 100%)",
                boxShadow: "0 4px 10px rgba(20, 46, 76, 0.12)",
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
              <NavLink to="/dashboard" style={(p) => linkStyle(mobile, p)}>
                📊 ダッシュボード
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
                ⚙️ 設定
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
  );
}
