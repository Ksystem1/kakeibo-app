import { useCallback, useEffect, useState } from "react";
import { Outlet, Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  canSendAuthenticatedRequest,
  getAuthMe,
  getHeaderAnnouncement,
  ledgerKidWatchApiOptionsFromSearch,
  normalizeAuthContextUser,
  normalizeFamilyRole,
  shouldShowFamilyChatDock,
} from "../lib/api";
import { useAdminSupportNeedsReplyBadge } from "../hooks/useAdminSupportNeedsReplyBadge";
import { useSupportChatUnreadBadge } from "../hooks/useSupportChatUnreadBadge";
import "./AppLayout.nav.css";
import "./AppLayout.glassNav.css";
import { AdSlot } from "./AdSlot";
import { AiAdvisorChat } from "./AiAdvisorChat";
import { FamilyChatDock } from "./FamilyChatDock";
import { GlassMainNav } from "./GlassMainNav";
import { HeaderAnnouncementBar } from "./HeaderAnnouncementBar";
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
    display: "inline-flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
}

export function AppLayout() {
  const { token, user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const location = useLocation();

  const isFamilyKid = normalizeFamilyRole(user?.familyRole) === "KID";
  const isParentLedger = (() => {
    const r = normalizeFamilyRole(user?.familyRole);
    return r === "ADMIN" || r === "MEMBER";
  })();
  const kidWatchHeader =
    Boolean(token) &&
    !isFamilyKid &&
    isParentLedger &&
    location.pathname === "/" &&
    Boolean(ledgerKidWatchApiOptionsFromSearch(location.search));

  /** 親向け: フローティングガラス本ナビ。未ログイン / KID は出さない。 */
  const showGlassMainNav = Boolean(token && !isFamilyKid);
  const routeAnimKey = `${location.pathname}${location.search}`;

  const isAdminUser =
    Boolean(user?.isAdmin) || user?.email?.toLowerCase() === "script_00123@yahoo.co.jp";

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      return () => {
        cancelled = true;
      };
    }
    void getAuthMe()
      .then((res) => {
        if (cancelled || !res?.user) return;
        const normalizedUser = normalizeAuthContextUser(res.user);
        if (
          Boolean(import.meta.env?.DEV) ||
          String(import.meta.env?.VITE_DEBUG_AUTH ?? "").trim() === "1"
        ) {
          // eslint-disable-next-line no-console
          console.info("[kakeibo:auth] /auth/me normalized user", normalizedUser);
        }
        setUser(normalizedUser);
      })
      .catch(() => {
        /* no-op */
      });
    return () => {
      cancelled = true;
    };
  }, [token, setUser]);

  const supportFamilyId =
    user?.familyId != null && Number.isFinite(Number(user.familyId))
      ? Number(user.familyId)
      : null;
  const { unread: supportChatUnread } = useSupportChatUnreadBadge({
    token,
    familyId: supportFamilyId,
    enabled: Boolean(token && canSendAuthenticatedRequest(token)),
  });

  const { needsReplyCount: adminSupportNeedsReply, refresh: refreshAdminSupportQueue } =
    useAdminSupportNeedsReplyBadge({
      token,
      enabled: Boolean(token && isAdminUser && canSendAuthenticatedRequest(token)),
    });

  useEffect(() => {
    if (!isAdminUser || !token || !canSendAuthenticatedRequest(token)) return;
    if (location.pathname.startsWith("/admin")) {
      void refreshAdminSupportQueue();
    }
  }, [location.pathname, isAdminUser, token, refreshAdminSupportQueue]);

  const [headerAnnouncement, setHeaderAnnouncement] = useState("");
  const fetchHeaderAnnouncement = useCallback(() => {
    void getHeaderAnnouncement()
      .then((r) => setHeaderAnnouncement(typeof r.text === "string" ? r.text : ""))
      .catch(() => setHeaderAnnouncement(""));
  }, []);

  useEffect(() => {
    if (isFamilyKid) {
      setHeaderAnnouncement("");
      return;
    }
    fetchHeaderAnnouncement();
  }, [fetchHeaderAnnouncement, location.pathname, isFamilyKid]);

  useEffect(() => {
    const onUpdated = () => {
      if (isFamilyKid) {
        setHeaderAnnouncement("");
        return;
      }
      fetchHeaderAnnouncement();
    };
    window.addEventListener("kakeibo:header-announcement-updated", onUpdated);
    return () => window.removeEventListener("kakeibo:header-announcement-updated", onUpdated);
  }, [fetchHeaderAnnouncement, isFamilyKid]);

  return (
    <>
    <div className="app-layout-shell">
      {showGlassMainNav ? (
        <GlassMainNav
          isAdminUser={isAdminUser}
          adminSupportNeedsReply={adminSupportNeedsReply}
        />
      ) : null}
      <div
        className={[
          "app-layout-surface",
          showGlassMainNav && "app-layout-surface--glass-nav",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          minHeight: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
        style={{
          borderBottom: kidWatchHeader
            ? "2px solid rgba(109, 40, 217, 0.55)"
            : "1px solid var(--border)",
          padding: mobile ? "0.45rem 0.65rem 0.5rem" : "0.5rem 1rem 0.55rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.45rem",
          background: kidWatchHeader
            ? "linear-gradient(180deg, rgba(139, 92, 246, 0.2) 0%, var(--panel-bg) 72%)"
            : "var(--panel-bg)",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
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
          {!mobile && !isFamilyKid ? (
            <HeaderAnnouncementBar text={headerAnnouncement} />
          ) : null}
          {token && !isFamilyKid ? (
            <NavLink
              to="/support"
              end
              className={({ isActive }) =>
                `header-support-entry${isActive ? " header-support-entry--active" : ""}`
              }
              aria-label={
                supportChatUnread ? "運営サポート（運営からの未読メッセージがあります）" : "運営サポート"
              }
            >
              <span className="header-support-entry__icon" aria-hidden>
                💬
              </span>
              <span className="header-support-entry__label">
                {mobile ? "サポート" : "運営サポート"}
              </span>
              {supportChatUnread ? (
                <span className="header-support-entry__unread" title="運営からの未読があります" />
              ) : null}
            </NavLink>
          ) : null}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "0.45rem",
              minWidth: 0,
              flexShrink: 0,
              marginLeft: "auto",
            }}
          >
            {!mobile && !isFamilyKid ? (
              <MobileAccessQr fixedPath={`${import.meta.env.BASE_URL}login`} compact />
            ) : null}
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
        {mobile && !isFamilyKid && headerAnnouncement.trim() ? (
          <div className="header-announcement-mobile-row">
            <HeaderAnnouncementBar text={headerAnnouncement} />
          </div>
        ) : null}
        {!token ? (
          <nav
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: mobile ? "0.2rem" : "0.28rem",
              width: "100%",
              minWidth: 0,
              paddingTop: "0.4rem",
              borderTop: "1px solid var(--border)",
            }}
            aria-label="アカウント"
          >
            <NavLink to="/login" style={(p) => linkStyle(mobile, p)}>
              🔐 ログイン
            </NavLink>
            <NavLink to="/register" style={(p) => linkStyle(mobile, p)}>
              ✨ 新規登録
            </NavLink>
          </nav>
        ) : null}
        </header>
        <main
        style={{
          flex: 1,
          minHeight: 0,
        }}
        >
        <div key={routeAnimKey} className="app-route-fade" style={{ display: "block", minHeight: "100%" }}>
          <Outlet />
        </div>
        </main>
      {token && shouldShowFamilyChatDock(user) ? (
        <FamilyChatDock
          title={isFamilyKid ? "かぞくチャット" : "家族チャット"}
          variant={isFamilyKid ? "kid" : "default"}
          fabClearAiAdvisor={!isFamilyKid}
        />
      ) : null}
      {token && !isFamilyKid ? <AiAdvisorChat /> : null}
      <AdSlot placement="footer" />
      <footer
        style={{
          padding: "0.5rem 1rem 0.9rem",
          textAlign: "center",
          fontSize: "0.78rem",
          color: "var(--text-muted, #6b7280)",
          borderTop: "1px solid var(--border, #e5e7eb)",
          position: "relative",
          zIndex: 35,
          pointerEvents: "auto",
          minHeight: 44,
          overflow: "visible",
          flexShrink: 0,
        }}
      >
        <Link
          to="/legal"
          className="app-legal-link"
          style={{ color: "var(--accent, #2d9f6c)", textDecoration: "none", padding: "0.35rem 0.4rem" }}
        >
          特商法の表記・利用規約・取り込み方針（よくある質問）
        </Link>
      </footer>
      </div>
    </div>
    </>
  );
}
