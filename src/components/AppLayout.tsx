import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { AdSlot } from "./AdSlot";

const linkStyle = ({ isActive }: { isActive: boolean }) => ({
  fontWeight: isActive ? 700 : 500,
  color: isActive ? "var(--accent)" : "var(--text-muted)",
  textDecoration: "none",
  padding: "0.35rem 0.65rem",
  borderRadius: 8,
  border: isActive ? "1px solid rgba(61,214,180,0.35)" : "1px solid transparent",
  background: isActive ? "var(--accent-dim)" : "transparent",
});

export function AppLayout() {
  const { token, logout } = useAuth();
  const navigate = useNavigate();
  const mobile = useIsMobile();

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
          padding: "0.5rem 1rem",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem",
          background: "rgba(0,0,0,0.2)",
        }}
      >
        <strong style={{ marginRight: "0.5rem" }}>Kakeibo</strong>
        <NavLink to="/dev-api" style={linkStyle}>
          APIテスト
        </NavLink>
        {token ? (
          <>
            <NavLink to="/kakeibo" style={linkStyle} end>
              家計簿
            </NavLink>
            {!mobile ? (
              <NavLink to="/import" style={linkStyle}>
                CSV取込（PC）
              </NavLink>
            ) : null}
            <NavLink to="/receipt" style={linkStyle}>
              レシート
            </NavLink>
            <NavLink to="/members" style={linkStyle}>
              家族
            </NavLink>
            <NavLink to="/settings" style={linkStyle}>
              設定
            </NavLink>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => {
                logout();
                navigate("/login", { replace: true });
              }}
              style={{
                font: "inherit",
                cursor: "pointer",
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                borderRadius: 8,
                padding: "0.35rem 0.75rem",
              }}
            >
              ログアウト
            </button>
          </>
        ) : (
          <>
            <NavLink to="/login" style={linkStyle}>
              ログイン
            </NavLink>
            <NavLink to="/register" style={linkStyle}>
              新規登録
            </NavLink>
          </>
        )}
      </header>
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>
      <AdSlot placement="footer" />
    </div>
  );
}
