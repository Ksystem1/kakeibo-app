import { useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { getAuthMe, normalizeAuthContextUser } from "../lib/api";
import { AdSlot } from "./AdSlot";
import { MobileAccessQr } from "./MobileAccessQr";

function linkStyle(
  mobile: boolean,
  { isActive }: { isActive: boolean },
) {
  return {
    fontWeight: isActive ? 700 : 500,
    color: isActive ? "var(--accent)" : "var(--text-muted)",
    textDecoration: "none",
    padding: mobile ? "0.28rem 0.45rem" : "0.35rem 0.65rem",
    fontSize: mobile ? "0.8rem" : undefined,
    borderRadius: 8,
    border: isActive ? "1px solid rgba(61,214,180,0.35)" : "1px solid transparent",
    background: isActive ? "var(--accent-dim)" : "transparent",
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
          background: "rgba(0,0,0,0.2)",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
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
          <strong
            style={{
              letterSpacing: "-0.02em",
              flexShrink: 0,
              lineHeight: 1.2,
            }}
          >
            Kakeibo
          </strong>
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
            {!mobile ? <MobileAccessQr /> : null}
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
              <NavLink to="/" style={(p) => linkStyle(mobile, p)} end>
                家計簿
              </NavLink>
              {!mobile ? (
                <NavLink to="/import" style={(p) => linkStyle(mobile, p)}>
                  CSV取込（PC）
                </NavLink>
              ) : null}
              <NavLink to="/receipt" style={(p) => linkStyle(mobile, p)}>
                レシート
              </NavLink>
              <NavLink to="/members" style={(p) => linkStyle(mobile, p)}>
                家族
              </NavLink>
              <NavLink to="/categories" style={(p) => linkStyle(mobile, p)}>
                カテゴリ
              </NavLink>
              <NavLink to="/settings" style={(p) => linkStyle(mobile, p)}>
                設定
              </NavLink>
              {user &&
              (user.isAdmin ||
                user.email.toLowerCase() === "script_00123@yahoo.co.jp") ? (
                <NavLink to="/admin" style={(p) => linkStyle(mobile, p)}>
                  管理
                </NavLink>
              ) : null}
            </>
          ) : (
            <>
              <NavLink to="/login" style={(p) => linkStyle(mobile, p)}>
                ログイン
              </NavLink>
              <NavLink to="/register" style={(p) => linkStyle(mobile, p)}>
                新規登録
              </NavLink>
            </>
          )}
        </nav>
      </header>
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>
      <AdSlot placement="footer" />
    </div>
  );
}
