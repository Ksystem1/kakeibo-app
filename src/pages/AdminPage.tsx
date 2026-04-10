import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createAdminUser,
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
  family_peers: string | null;
};

const PW_RE = /^[a-zA-Z0-9]{8,}$/;
const LOGIN_ID_RE = /^[a-zA-Z0-9]{1,15}$/;
const NAME_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+$/u;

function formatAdminApiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/not found/i.test(msg)) {
    return "管理者APIが見つかりません。バックエンドが古い可能性があります。deploy.yml（ECS+Terraform）で再デプロイしてください。";
  }
  if (/forbidden|管理者権限が必要/i.test(msg)) {
    return "管理者権限がありません。管理者アカウントで再ログインしてください。";
  }
  if (/unauthorized|認証|401/.test(msg)) {
    return "認証エラーです。ログアウト後に再ログインしてください。";
  }
  return msg || "ユーザー一覧の取得に失敗しました";
}

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

function formatDateOnly(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function AdminPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayNameDrafts, setDisplayNameDrafts] = useState<Record<number, string>>({});
  const [tempPasswords, setTempPasswords] = useState<Record<number, string>>({});
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newLoginName, setNewLoginName] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);

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
      setError(formatAdminApiError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const adminCount = useMemo(() => items.filter((x) => x.isAdmin).length, [items]);

  /** 家族IDごとに 1 家族としてカウント（夫婦など複数ユーザーでも家族数は 1） */
  const familySummary = useMemo(() => {
    const byId = new Map<
      number,
      { userRows: number; peersLabel: string | null }
    >();
    let usersWithoutFamily = 0;
    for (const u of items) {
      const fid = u.default_family_id;
      if (fid == null) {
        usersWithoutFamily += 1;
        continue;
      }
      const cur = byId.get(fid);
      const label = u.family_peers?.trim() || null;
      if (!cur) {
        byId.set(fid, { userRows: 1, peersLabel: label });
      } else {
        cur.userRows += 1;
        if (!cur.peersLabel && label) cur.peersLabel = label;
      }
    }
    const families = [...byId.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([familyId, v]) => ({
        familyId,
        peersLabel: v.peersLabel,
        userRows: v.userRows,
      }));
    return {
      distinctFamilyCount: byId.size,
      usersWithoutFamily,
      families,
    };
  }, [items]);

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

  const onCreateUser = useCallback(async () => {
    const email = newEmail.trim().toLowerCase();
    const loginName = newLoginName.trim();
    const displayName = newDisplayName.trim();
    if (!email || !email.includes("@")) {
      setError("有効なメールアドレスを入力してください。");
      return;
    }
    if (!PW_RE.test(newPassword)) {
      setError("パスワードは英数字8文字以上にしてください。");
      return;
    }
    if (loginName && !LOGIN_ID_RE.test(loginName)) {
      setError("ログインIDは英数字のみ・最大15文字で入力してください。");
      return;
    }
    if (displayName && (!NAME_RE.test(displayName) || displayName.length > 10)) {
      setError("表示名は漢字・カナ・英数字のみ、最大10文字で入力してください。");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await createAdminUser({
        email,
        password: newPassword,
        login_name: loginName || undefined,
        display_name: displayName || undefined,
        isAdmin: newIsAdmin,
      });
      setNewEmail("");
      setNewLoginName("");
      setNewDisplayName("");
      setNewPassword("");
      setNewIsAdmin(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ユーザー追加に失敗しました");
    } finally {
      setCreating(false);
    }
  }, [newEmail, newLoginName, newDisplayName, newPassword, newIsAdmin, load]);

  return (
    <section style={{ padding: "1rem", maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>管理者ダッシュボード</h1>
      <p style={{ color: "var(--text-muted)" }}>
        管理者数: {adminCount} / 全ユーザー: {items.length}
      </p>
      <div
        style={{
          margin: "0.8rem 0 1rem",
          padding: "0.9rem 1rem",
          borderRadius: 12,
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
        }}
      >
        <h2 style={{ margin: "0 0 0.65rem", fontSize: "1.02rem" }}>ユーザー追加</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "0.55rem",
          }}
        >
          <input
            type="email"
            placeholder="メールアドレス（必須）"
            value={newEmail}
            disabled={creating}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <input
            type="text"
            placeholder="ログインID（任意）"
            value={newLoginName}
            maxLength={15}
            disabled={creating}
            onChange={(e) => setNewLoginName(e.target.value)}
          />
          <input
            type="text"
            placeholder="表示名（任意）"
            value={newDisplayName}
            maxLength={10}
            disabled={creating}
            onChange={(e) => setNewDisplayName(e.target.value)}
          />
          <input
            type="password"
            placeholder="初期パスワード（英数字8文字以上）"
            value={newPassword}
            disabled={creating}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div style={{ marginTop: "0.65rem", display: "flex", alignItems: "center", gap: "0.7rem" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <input
              type="checkbox"
              checked={newIsAdmin}
              disabled={creating}
              onChange={(e) => setNewIsAdmin(e.target.checked)}
            />
            管理者として作成
          </label>
          <button
            type="button"
            disabled={creating}
            onClick={() => {
              void onCreateUser();
            }}
          >
            {creating ? "追加中..." : "ユーザー追加"}
          </button>
        </div>
      </div>
      <div
        style={{
          margin: "0.8rem 0 1rem",
          padding: "1rem 1.1rem",
          borderRadius: 12,
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
          boxShadow: "0 2px 8px rgba(16, 36, 60, 0.08)",
        }}
      >
        <h2 style={{ margin: "0 0 0.65rem", fontSize: "1.05rem", lineHeight: 1.35 }}>家族IDサマリ</h2>
        <p style={{ margin: "0 0 0.7rem", fontSize: "0.95rem", lineHeight: 1.65, color: "var(--text-muted)" }}>
          同じ家族IDは<strong> 1 家族</strong>として数えます（例: 本人・招待者の 2 ユーザーでも家族数は 1）。
        </p>
        <ul style={{ margin: "0 0 0.8rem", paddingLeft: "1.25rem", fontSize: "0.96rem", lineHeight: 1.7 }}>
          <li>
            <strong>登録家族数（ユニークな家族ID）</strong>: {familySummary.distinctFamilyCount}
          </li>
          <li>
            <strong>家族未設定のユーザー行</strong>: {familySummary.usersWithoutFamily}
          </li>
        </ul>
        {familySummary.families.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.9rem" }}>
            家族に紐づくユーザーはいません。
          </p>
        ) : (
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.25rem",
              fontSize: "0.94rem",
              lineHeight: 1.75,
              color: "var(--text)",
            }}
          >
            {familySummary.families.map((f) => (
              <li key={f.familyId} style={{ marginBottom: "0.5rem" }}>
                <strong>家族ID {f.familyId}</strong>
                {f.userRows > 1 ? (
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}
                   （一覧上 {f.userRows} 行 = 同一家族のユーザー数）
                  </span>
                ) : null}
                <br />
                <span style={{ color: "var(--text-muted)" }}>
                  {f.peersLabel ?? "（メンバー表記なし）"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        style={{
          margin: "0.8rem 0 1rem",
          padding: "0.75rem 0.9rem",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--panel-bg)",
        }}
      >
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "0.98rem" }}>管理者一覧（サマリ）</h2>
        {adminCount === 0 ? (
          <p style={{ margin: 0, color: "var(--text-muted)" }}>現在、管理者ユーザーは登録されていません。</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.9rem" }}>
            {items
              .filter((u) => u.isAdmin)
              .map((u) => (
                <li key={u.id}>
                  ID {u.id} — {u.email}（最終ログイン: {formatDateTime(u.last_login_at)})
                </li>
              ))}
          </ul>
        )}
      </div>
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
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1380 }}>
          <thead>
            <tr style={{ background: "var(--panel-bg)" }}>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>ID</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>メール</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>登録日</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>最終ログイン</th>
              <th style={{ textAlign: "left", padding: "0.7rem" }}>家族ID</th>
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
                  {formatDateOnly(u.created_at)}
                </td>
                <td style={{ padding: "0.7rem", whiteSpace: "nowrap" }}>
                  {formatDateTime(u.last_login_at)}
                </td>
                <td style={{ padding: "0.7rem", whiteSpace: "nowrap" }}>
                  {u.default_family_id != null ? u.default_family_id : "—"}
                </td>
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
                <td colSpan={11} style={{ padding: "1rem", color: "var(--text-muted)" }}>
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
