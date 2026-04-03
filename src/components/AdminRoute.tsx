import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getAuthMe, normalizeAuthContextUser } from "../lib/api";

export function AdminRoute() {
  const { token, user, setUser, logout } = useAuth();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setChecked(true);
      return () => {
        cancelled = true;
      };
    }
    // false も boolean のため、ここで省略すると管理者昇格後も /admin に入れない
    void getAuthMe()
      .then((res) => {
        if (cancelled) return;
        if (res?.user) {
          setUser(normalizeAuthContextUser(res.user));
        }
        setChecked(true);
      })
      .catch(() => {
        if (cancelled) return;
        logout();
        setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, setUser, logout]);

  if (!token) return <Navigate to="/login" replace />;
  // 初回は user が null のまま。checked 前に !user?.isAdmin で弾くと常に / へ飛んでいた。
  if (!checked) return <div style={{ padding: "1rem" }}>確認中...</div>;
  const isSuperAdmin =
    user?.email?.toLowerCase() === "script_00123@yahoo.co.jp";
  if (!user || (!user.isAdmin && !isSuperAdmin)) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
