import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteAdminUser,
  getAdminUsers,
  resetAdminUserPassword,
  updateAdminUser,
} from "../lib/api";

type AdminUser = {
  id: number;
  email: string;
  login_name: string | null;
  display_name: string | null;
  isAdmin: boolean;
  created_at: string | null;
  updated_at: string | null;
  last_login_at: string | null;
  default_family_id: number | null;
  family_name: string | null;
  family_peers: string | null;
};

function formatDateTime(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function AdminPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayNameDrafts, setDisplayNameDrafts] = useState<Record<number, string>>({});
  const [tempPasswords, setTempPasswords] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAdminUsers();
      const list = Array.isArray(res.items) ? res.items : [];
      setItems(list);
      setDisplayNameDrafts(
        Object.fromEntries(
          list.map((u) => [u.id, u.display_name ?? ""]),
        ),
      );
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

  const onSaveDisplayName = useCallback(
    async (userId: number) => {
      setSavingUserId(userId);
      setError(null);
      try {
        const next = (displayNameDrafts[userId] ?? "").trim();
        await updateAdminUser(userId, { displayName: next || null });
        setItems((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, display_name: next || null } : u)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "表示名更新に失敗しました");
      } finally {
        setSavingUserId(null);
      }
    },
    [displayNameDrafts],
  );

  const onResetPassword = useCallback(async (userId: number, email: string) => {
    if (!window.confirm(`${email} のパスワードを初期化します。続行しますか？`)) return;
    setSavingUserId(userId);
    setError(null);
    try {
      const res = await resetAdminUserPassword(userId);
      setTempPasswords((prev) => ({ ...prev, [userId]: res.temporaryPassword }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "パスワード初期化に失敗しました");
    } finally {
      setSavingUserId(null);
    }
  }, []);

  const onDeleteUser = useCallback(async (userId: number, email: string) => {
    if (!window.confirm(`${email} を削除します。この操作は取り消せません。`)) return;
    setSavingUserId(userId);
    setError(null);
    try {
      await deleteAdminUser(userId);
      setItems((prev) => prev.filter((u) => u.id !== userId));
      setDisplayNameDrafts((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setTempPasswords((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "ユーザー削除に失敗しました");
    } finally {
      setSavingUserId(null);
    }
  }, []);

  return (
    <section style={{ padding: "1rem", maxWidth: 1400, margin: "0 auto" }}>
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
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1520 }}>
          <thead>
            <tr style={{ background: "var(--panel-bg)" }}>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>ID</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>メール</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>登録日</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>最終ログイン</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>家族ID</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>家族名</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>家族メンバー</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>表示名</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>ログイン名</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>管理者</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>パスワード</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>削除</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "0.7rem" }}>{u.id}</td>
                <td style={{ padding: "0.7rem" }}>{u.email}</td>
                <td style={{ padding: "0.7rem", whiteSpace: "nowrap" }}>
                  {formatDateTime(u.created_at)}
                </td>
                <td style={{ padding: "0.7rem", whiteSpace: "nowrap" }}>
                  {formatDateTime(u.last_login_at)}
                </td>
                <td style={{ padding: "0.7rem", whiteSpace: "nowrap" }}>
                  {u.default_family_id != null ? u.default_family_id : "—"}
                </td>
                <td style={{ padding: "0.7rem" }}>{u.family_name ?? "—"}</td>
                <td style={{ padding: "0.7rem", maxWidth: 280, wordBreak: "break-word" }}>
                  {u.family_peers ?? "—"}
                </td>
                <td style={{ padding: "0.7rem" }}>
                  <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="text"
                      value={displayNameDrafts[u.id] ?? ""}
                      disabled={savingUserId === u.id}
                      onChange={(e) =>
                        setDisplayNameDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))
                      }
                      style={{ minWidth: 140 }}
                    />
                    <button
                      type="button"
                      disabled={savingUserId === u.id}
                      onClick={() => {
                        void onSaveDisplayName(u.id);
                      }}
                    >
                      保存
                    </button>
                  </div>
                </td>
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
                <td style={{ padding: "0.7rem" }}>
                  <button
                    type="button"
                    disabled={savingUserId === u.id}
                    onClick={() => {
                      void onResetPassword(u.id, u.email);
                    }}
                  >
                    初期化
                  </button>
                  {tempPasswords[u.id] ? (
                    <div style={{ marginTop: "0.35rem", color: "var(--text-muted)" }}>
                      一時PW: <code>{tempPasswords[u.id]}</code>
                    </div>
                  ) : null}
                </td>
                <td style={{ padding: "0.7rem" }}>
                  <button
                    type="button"
                    disabled={savingUserId === u.id}
                    onClick={() => {
                      void onDeleteUser(u.id, u.email);
                    }}
                    style={{ color: "#b42318" }}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 ? (
              <tr>
                <td colSpan={12} style={{ padding: "1rem", color: "var(--text-muted)" }}>
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
