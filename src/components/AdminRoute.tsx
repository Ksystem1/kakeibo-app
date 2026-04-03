import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getAuthMe } from "../lib/api";

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
    if (typeof user?.isAdmin === "boolean") {
      setChecked(true);
      return () => {
        cancelled = true;
      };
    }
    void getAuthMe()
      .then((res) => {
        if (cancelled) return;
        if (res?.user) {
          setUser({
            id: Number(res.user.id),
            email: String(res.user.email),
            familyId: res.user.familyId ?? null,
            isAdmin: Boolean(res.user.isAdmin),
          });
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
  }, [token, user?.isAdmin, setUser, logout]);

  if (!token) return <Navigate to="/login" replace />;
  // 初回は user が null のまま。checked 前に !user?.isAdmin で弾くと常に / へ飛んでいた。
  if (!checked) return <div style={{ padding: "1rem" }}>確認中...</div>;
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <Outlet />;
}
