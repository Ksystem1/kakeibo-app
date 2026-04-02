import { useCallback, useEffect, useMemo, useState } from "react";
import { getAdminUsers, updateAdminUser } from "../lib/api";

type AdminUser = {
  id: number;
  email: string;
  login_name: string | null;
  display_name: string | null;
  isAdmin: boolean;
  created_at: string | null;
  updated_at: string | null;
  default_family_id: number | null;
};

export function AdminPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAdminUsers();
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ユーザー一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const adminCount = useMemo(() => items.filter((x) => x.isAdmin).length, [items]);

  const onToggleAdmin = useCallback(
    async (userId: number, nextValue: boolean) => {
      setSavingUserId(userId);
      setError(null);
      try {
        await updateAdminUser(userId, { isAdmin: nextValue });
        setItems((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, isAdmin: nextValue } : u)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "ユーザー更新に失敗しました");
      } finally {
        setSavingUserId(null);
      }
    },
    [],
  );

  return (
    <section style={{ padding: "1rem", maxWidth: 1080, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>管理者ダッシュボード</h1>
      <p style={{ color: "var(--text-muted)" }}>
        管理者数: {adminCount} / 全ユーザー: {items.length}
      </p>
      {error ? <p style={{ color: "#b42318", fontWeight: 600 }}>{error}</p> : null}
      <button
        type="button"
        onClick={() => {
          void load();
        }}
        disabled={loading}
        style={{ marginBottom: "0.8rem" }}
      >
        {loading ? "読み込み中..." : "再読み込み"}
      </button>
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
          <thead>
            <tr style={{ background: "var(--panel-bg)" }}>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>ID</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>メール</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>表示名</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>ログイン名</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>管理者</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "0.7rem" }}>{u.id}</td>
                <td style={{ padding: "0.7rem" }}>{u.email}</td>
                <td style={{ padding: "0.7rem" }}>{u.display_name ?? "-"}</td>
                <td style={{ padding: "0.7rem" }}>{u.login_name ?? "-"}</td>
                <td style={{ padding: "0.7rem" }}>
                  <label style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={u.isAdmin}
                      disabled={savingUserId === u.id}
                      onChange={(e) => {
                        void onToggleAdmin(u.id, e.target.checked);
                      }}
                    />
                    {u.isAdmin ? "admin" : "user"}
                  </label>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "1rem", color: "var(--text-muted)" }}>
                  ユーザーが見つかりません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
