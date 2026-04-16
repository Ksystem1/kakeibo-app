import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Outlet,
  NavLink,
  matchPath,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../context/SettingsContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { getAuthMe, normalizeAuthContextUser } from "../lib/api";
import "./AppLayout.nav.css";
import { AdSlot } from "./AdSlot";
import { AiAdvisorChat } from "./AiAdvisorChat";
import { MobileAccessQr } from "./MobileAccessQr";

/** テキストナビ（未ログインのログイン・新規登録など） */
function linkStyle(
  mobile: boolean,
  { isActive }: { isActive: boolean },
) {
  return {
    fontWeight: isActive ? 700 : 600,
    color: isActive ? "var(--text)" : "var(--text-muted)",
    textDecoration: "none",
    padding: mobile ? "0.46rem 0.62rem" : "0.58rem 0.82rem",
    fontSize: mobile ? "0.8rem" : undefined,
    borderRadius: 10,
    border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: isActive ? "var(--accent-dim)" : "var(--bg-card)",
    boxShadow: isActive
      ? "0 3px 8px rgba(22, 108, 182, 0.18)"
      : "0 1px 4px rgba(15, 43, 71, 0.08)",
    whiteSpace: "nowrap" as const,
    minHeight: mobile ? 54 : 62,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function navIconLinkClassName({ isActive }: { isActive: boolean }) {
  return `nav-icon-link${isActive ? " is-active" : ""}`;
}

/** スマホ: 対応するナビ行の直下にだけ子ルートを描画（PC は main の Outlet のみ） */
function MobileInlineOutlet(props: {
  path: string;
  end?: boolean;
  pathname: string;
  visible: boolean;
}) {
  const { path, end, pathname, visible } = props;
  if (!visible) return null;
  if (!matchPath({ path, end: end ?? false }, pathname)) return null;
  return (
    <div className="app-mobile-route-panel">
      <Outlet />
    </div>
  );
}

export function AppLayout() {
  const { token, user, setUser, logout } = useAuth();
  const { navIconPaths } = useSettings();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const location = useLocation();
  const [mobileMainHidden, setMobileMainHidden] = useState(false);
  const prevPathnameRef = useRef<string | null>(null);

  /** スマホで別ルートへ移ったらメインを再表示（同一ルート再タップでの閉じるはトグルで維持） */
  useEffect(() => {
    if (!mobile) {
      setMobileMainHidden(false);
      prevPathnameRef.current = null;
      return;
    }
    const prev = prevPathnameRef.current;
    prevPathnameRef.current = location.pathname;
    if (prev !== null && prev !== location.pathname) {
      setMobileMainHidden(false);
    }
  }, [location.pathname, mobile]);

  const onMobileIconNavClick =
    (to: string, end?: boolean) => (e: MouseEvent<HTMLAnchorElement>) => {
      if (!mobile) return;
      const active =
        matchPath({ path: to, end: end ?? false }, location.pathname) != null;
      if (active) {
        e.preventDefault();
        setMobileMainHidden((h) => !h);
      } else {
        setMobileMainHidden(false);
      }
    };

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

  const showMobileInlineOutlet = Boolean(
    mobile && token && !mobileMainHidden,
  );
  const useMobileInlineOutlet = Boolean(mobile && token);

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
          className={token && mobile ? "app-nav--mobile-column" : undefined}
          style={{
            display: "flex",
            flexWrap: mobile && token ? "nowrap" : "wrap",
            alignItems: mobile && token ? "stretch" : "center",
            gap: mobile ? "0.2rem" : "0.28rem",
            width: "100%",
            minWidth: 0,
            paddingTop: "0.4rem",
            borderTop: "1px solid var(--border)",
          }}
          aria-label="メインメニュー"
        >
          {token ? (
            <>
              <NavLink
                to="/dashboard"
                className={navIconLinkClassName}
                aria-label="ダッシュボード"
                onClick={onMobileIconNavClick("/dashboard")}
              >
                <img className="nav-icon-img" src={navIconPaths.dashboard} alt="" aria-hidden="true" />
              </NavLink>
              {useMobileInlineOutlet ? (
                <MobileInlineOutlet
                  path="/dashboard"
                  pathname={location.pathname}
                  visible={showMobileInlineOutlet}
                />
              ) : null}
              <NavLink
                to="/"
                className={navIconLinkClassName}
                end
                aria-label="家計簿"
                onClick={onMobileIconNavClick("/", true)}
              >
                <img className="nav-icon-img" src={navIconPaths.kakeibo} alt="" aria-hidden="true" />
              </NavLink>
              {useMobileInlineOutlet ? (
                <MobileInlineOutlet
                  path="/"
                  end
                  pathname={location.pathname}
                  visible={showMobileInlineOutlet}
                />
              ) : null}
              <NavLink
                to="/receipt"
                className={navIconLinkClassName}
                aria-label="レシート"
                onClick={onMobileIconNavClick("/receipt")}
              >
                <img className="nav-icon-img nav-icon-img--smaller" src={navIconPaths.receipt} alt="" aria-hidden="true" />
              </NavLink>
              {useMobileInlineOutlet ? (
                <MobileInlineOutlet
                  path="/receipt"
                  pathname={location.pathname}
                  visible={showMobileInlineOutlet}
                />
              ) : null}
              {!mobile ? (
                <NavLink to="/import" className={navIconLinkClassName} aria-label="CSV取込（PC）">
                  <img className="nav-icon-img" src={navIconPaths.csvPc} alt="" aria-hidden="true" />
                </NavLink>
              ) : null}
              {useMobileInlineOutlet ? (
                <MobileInlineOutlet
                  path="/import"
                  pathname={location.pathname}
                  visible={showMobileInlineOutlet}
                />
              ) : null}
              <NavLink
                to="/settings"
                className={navIconLinkClassName}
                aria-label="設定"
                onClick={onMobileIconNavClick("/settings")}
              >
                <img className="nav-icon-img nav-icon-img--smaller" src={navIconPaths.settings} alt="" aria-hidden="true" />
              </NavLink>
              {useMobileInlineOutlet ? (
                <MobileInlineOutlet
                  path="/settings"
                  pathname={location.pathname}
                  visible={showMobileInlineOutlet}
                />
              ) : null}
              {user &&
              (user.isAdmin ||
                user.email.toLowerCase() === "script_00123@yahoo.co.jp") ? (
                <NavLink
                  to="/admin"
                  className={navIconLinkClassName}
                  aria-label="管理"
                  onClick={onMobileIconNavClick("/admin")}
                >
                  <img className="nav-icon-img nav-icon-img--smaller" src={navIconPaths.admin} alt="" aria-hidden="true" />
                </NavLink>
              ) : null}
              {useMobileInlineOutlet &&
              user &&
              (user.isAdmin ||
                user.email.toLowerCase() === "script_00123@yahoo.co.jp") ? (
                <MobileInlineOutlet
                  path="/admin"
                  pathname={location.pathname}
                  visible={showMobileInlineOutlet}
                />
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
        {mobile && token && mobileMainHidden ? (
          <div hidden aria-hidden>
            <Outlet />
          </div>
        ) : null}
      </header>
      <main
        style={{
          flex: mobile && token ? 0 : 1,
          minHeight: 0,
          display: mobile && token ? "none" : undefined,
        }}
        aria-hidden={mobile && token ? true : undefined}
      >
        {!(mobile && token) ? (
          <div style={{ display: "block", minHeight: "100%" }}>
            <Outlet />
          </div>
        ) : null}
      </main>
      {token ? <AiAdvisorChat /> : null}
      <AdSlot placement="footer" />
    </div>
    </>
  );
}
