import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  createAdminUser,
  deleteAdminUser,
  getAdminAnnouncement,
  getAdminMonitorRecruitmentSettings,
  getAdminPayPayImportSummary,
  getAdminUsers,
  putAdminAnnouncement,
  putAdminMonitorRecruitmentSettings,
  resetAdminUserPassword,
  updateAdminUser,
} from "../lib/api";
import {
  ADMIN_SUBSCRIPTION_STATUSES,
  subscriptionStatusLabelJa,
} from "../lib/subscriptionStatusLabels";
import {
  isValidNewPassword,
  NEW_PASSWORD_ERROR_MESSAGE,
  NEW_PASSWORD_LABEL,
  NEW_PASSWORD_TOOLTIP,
} from "../lib/passwordPolicy";

type AdminUser = {
  id: number;
  email: string;
  login_name: string | null;
  display_name: string | null;
  isAdmin: boolean;
  subscriptionStatus: string;
  created_at: string | null;
  updated_at: string | null;
  last_login_at: string | null;
  default_family_id: number | null;
  /** users.family_role（未対応 API では undefined） */
  familyRole?: string;
  family_peers: string | null;
};

type AdminFamilyGroup = {
  familyKey: string;
  familyId: number | null;
  members: AdminUser[];
  memberLabelLines: string[];
};

const LOGIN_ID_RE = /^[a-zA-Z0-9]{1,15}$/;
const NAME_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+$/u;

/** 管理者ユーザー一覧テーブル: 行の縦余白を抑え、文字サイズを揃える */
const adminTableTh = {
  textAlign: "left" as const,
  padding: "0.28rem 0.65rem",
  fontSize: "0.78rem",
  fontWeight: 600 as const,
  lineHeight: 1.2,
  whiteSpace: "nowrap" as const,
};
const adminTableTd = {
  padding: "0.28rem 0.65rem",
  fontSize: "0.8125rem",
  lineHeight: 1.25,
  verticalAlign: "middle" as const,
};
const adminTableBtn = {
  whiteSpace: "nowrap" as const,
  padding: "0.2rem 0.5rem",
  fontSize: "0.8125rem",
  lineHeight: 1.2,
};

const FAMILY_ROLE_LABELS: Record<string, string> = {
  ADMIN: "管理者（家計）",
  MEMBER: "メンバー",
  KID: "子ども（本人のみ）",
};
const ADMIN_FAMILY_ROLES = ["ADMIN", "MEMBER", "KID"] as const;

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

/** 管理者一覧の family_peers（改行区切りまたは従来の " / " 区切り）を行配列に */
function familyPeersToLines(peers: string): string[] {
  const s = peers.trim();
  if (!s) return [];
  if (/\r?\n/.test(s)) {
    return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  return s.split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
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

const FAMILY_LABELS_STORAGE_KEY = "kakeibo_admin_family_labels";

function readFamilyLabelsFromStorage(): Record<string, string> {
  try {
    const raw = localStorage.getItem(FAMILY_LABELS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function AdminPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayNameDrafts, setDisplayNameDrafts] = useState<Record<number, string>>({});
  const [familyIdDrafts, setFamilyIdDrafts] = useState<Record<number, string>>({});
  const [familyRoleDrafts, setFamilyRoleDrafts] = useState<Record<number, string>>({});
  const [tempPasswords, setTempPasswords] = useState<Record<number, string>>({});
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newLoginName, setNewLoginName] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  /** RDS に users.subscription_status が無いとき false（一覧は表示、プルダウンは無効） */
  const [subscriptionStatusWritable, setSubscriptionStatusWritable] = useState(true);
  const [announcementDraft, setAnnouncementDraft] = useState("");
  const [announcementBusy, setAnnouncementBusy] = useState(false);
  const [announcementMessage, setAnnouncementMessage] = useState<string | null>(null);
  const [monitorRecruitmentEnabled, setMonitorRecruitmentEnabled] = useState(false);
  const [monitorRecruitmentText, setMonitorRecruitmentText] = useState("");
  const [monitorRecruitmentBusy, setMonitorRecruitmentBusy] = useState(false);
  const [monitorRecruitmentMessage, setMonitorRecruitmentMessage] = useState<string | null>(null);
  const [monitorRecruitmentLoadError, setMonitorRecruitmentLoadError] = useState<string | null>(null);
  const [familyLabelDrafts, setFamilyLabelDrafts] = useState<Record<string, string>>(() =>
    readFamilyLabelsFromStorage(),
  );
  const [paypayImportSummary, setPaypayImportSummary] = useState<
    Array<{
      user_id: number;
      user_email: string | null;
      last_import_at: string | null;
      run_count: number;
      total_rows: number;
      new_count: number;
      updated_count: number;
      aggregated_count: number;
      excluded_count: number;
      error_count: number;
    }>
  >([]);
  const [paypayMonitorError, setPaypayMonitorError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FAMILY_LABELS_STORAGE_KEY, JSON.stringify(familyLabelDrafts));
    } catch {
      /* ignore */
    }
  }, [familyLabelDrafts]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, ann] = await Promise.all([
        getAdminUsers(),
        getAdminAnnouncement().catch(() => ({ text: "" })),
      ]);
      setMonitorRecruitmentLoadError(null);
      let monitorRecruitment: { enabled: boolean; text: string; migrationMissing?: boolean } = {
        enabled: false,
        text: "",
      };
      try {
        monitorRecruitment = await getAdminMonitorRecruitmentSettings();
        if (monitorRecruitment.migrationMissing) {
          setMonitorRecruitmentLoadError(
            "DB に db/migration_v25_monitor_recruitment_settings.sql が未適用の可能性があります。",
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setMonitorRecruitmentLoadError(msg);
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.error("[Admin] getAdminMonitorRecruitmentSettings", e);
        }
      }
      const monitor = await getAdminPayPayImportSummary().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setPaypayMonitorError(
          msg && msg.trim()
            ? msg
            : "PayPay取込モニターを取得できません。APIデプロイまたは migration v24 の適用状態を確認してください。",
        );
        return { items: [] };
      });
      const list = Array.isArray(res.items) ? res.items : [];
      setItems(list);
      if (Array.isArray(monitor.items)) {
        setPaypayMonitorError(null);
      }
      setPaypayImportSummary(Array.isArray(monitor.items) ? monitor.items : []);
      setSubscriptionStatusWritable(res.meta?.subscriptionStatusWritable !== false);
      setDisplayNameDrafts(
        Object.fromEntries(
          list.map((u) => [u.id, u.display_name ?? ""]),
        ),
      );
      setFamilyIdDrafts(
        Object.fromEntries(
          list.map((u) => [u.id, u.default_family_id != null ? String(u.default_family_id) : ""]),
        ),
      );
      setFamilyRoleDrafts(
        Object.fromEntries(
          list.map((u) => [
            u.id,
            String(u.familyRole ?? "MEMBER")
              .trim()
              .toUpperCase() || "MEMBER",
          ]),
        ),
      );
      setAnnouncementDraft(typeof ann.text === "string" ? ann.text : "");
      setMonitorRecruitmentEnabled(monitorRecruitment.enabled === true);
      setMonitorRecruitmentText(typeof monitorRecruitment.text === "string" ? monitorRecruitment.text : "");
    } catch (e) {
      setSubscriptionStatusWritable(true);
      setError(formatAdminApiError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const adminCount = useMemo(() => items.filter((x) => x.isAdmin).length, [items]);

  const familyGroups = useMemo<AdminFamilyGroup[]>(() => {
    const m = new Map<string, AdminFamilyGroup>();
    for (const u of items) {
      const familyId = u.default_family_id != null ? Number(u.default_family_id) : null;
      const familyKey = familyId != null && Number.isFinite(familyId) ? `fid:${familyId}` : `solo:${u.id}`;
      const existing = m.get(familyKey);
      if (existing) {
        existing.members.push(u);
      } else {
        m.set(familyKey, {
          familyKey,
          familyId: familyId != null && Number.isFinite(familyId) ? familyId : null,
          members: [u],
          memberLabelLines: [],
        });
      }
    }
    const groups = Array.from(m.values());
    for (const g of groups) {
      const set = new Set<string>();
      for (const member of g.members) {
        const lines = familyPeersToLines(String(member.family_peers ?? ""));
        for (const line of lines) set.add(line);
      }
      g.memberLabelLines = Array.from(set);
      g.members.sort((a, b) => a.id - b.id);
    }
    groups.sort((a, b) => {
      if (a.familyId == null && b.familyId == null) return a.members[0].id - b.members[0].id;
      if (a.familyId == null) return 1;
      if (b.familyId == null) return -1;
      return a.familyId - b.familyId;
    });
    return groups;
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

  const onApplyFamilySettings = useCallback(
    async (userId: number) => {
      const u = items.find((x) => x.id === userId);
      if (!u) return;
      setSavingUserId(userId);
      setError(null);
      try {
        const famRaw = (familyIdDrafts[userId] ?? "").trim();
        let nextFam: number | null = null;
        if (famRaw !== "") {
          const n = Number(famRaw);
          if (!Number.isFinite(n) || n <= 0) {
            setError("家族IDは正の数で入力するか、空にしてください。");
            setSavingUserId(null);
            return;
          }
          nextFam = n;
        }
        const prevFam = u.default_family_id ?? null;
        const nextRole = ((familyRoleDrafts[userId] ?? "MEMBER").trim().toUpperCase() || "MEMBER") as
          | "ADMIN"
          | "MEMBER"
          | "KID";
        const prevRole = (String(u.familyRole ?? "MEMBER").trim().toUpperCase() || "MEMBER") as
          | "ADMIN"
          | "MEMBER"
          | "KID";

        const body: {
          defaultFamilyId?: number | null;
          familyRole?: "ADMIN" | "MEMBER" | "KID";
        } = {};
        if (nextFam !== prevFam) {
          body.defaultFamilyId = nextFam;
        }
        if (nextRole !== prevRole) {
          body.familyRole = nextRole;
        }
        if (Object.keys(body).length === 0) {
          setSavingUserId(null);
          return;
        }
        await updateAdminUser(userId, body);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "家族設定の更新に失敗しました");
      } finally {
        setSavingUserId(null);
      }
    },
    [items, familyIdDrafts, familyRoleDrafts, load],
  );

  const onSetSubscriptionStatus = useCallback(
    async (userId: number, nextStatus: string) => {
      setSavingUserId(userId);
      setError(null);
      try {
        await updateAdminUser(userId, { subscriptionStatus: nextStatus });
        setItems((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, subscriptionStatus: nextStatus } : u)),
        );
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "サブスクリプション状態の更新に失敗しました",
        );
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
    if (!isValidNewPassword(newPassword)) {
      setError(NEW_PASSWORD_ERROR_MESSAGE);
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
      <p style={{ margin: "0.35rem 0 0.75rem" }}>
        <Link
          to="/admin/chat"
          style={{
            fontWeight: 600,
            color: "var(--accent)",
            textDecoration: "none",
          }}
        >
          サポートチャット（家族一覧・返信）→
        </Link>
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
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.02rem" }}>ヘッダーお知らせ</h2>
        <p style={{ margin: "0 0 0.65rem", fontSize: "0.88rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
          ログイン後ヘッダー（Kakeibo とログアウトの間）に 1 行で表示されます。空にすると非表示です。最大 512 文字・改行は空白にまとめられます。
        </p>
        <textarea
          value={announcementDraft}
          onChange={(e) => setAnnouncementDraft(e.target.value)}
          maxLength={512}
          rows={2}
          disabled={announcementBusy || loading}
          placeholder="例: メンテナンスは 4/20 2:00〜 を予定しています"
          style={{
            width: "100%",
            boxSizing: "border-box",
            font: "inherit",
            fontSize: "0.92rem",
            padding: "0.5rem 0.6rem",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--input-bg)",
            color: "var(--text)",
            resize: "vertical",
            minHeight: "3.2rem",
          }}
        />
        <div style={{ marginTop: "0.55rem", display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            disabled={announcementBusy || loading}
            onClick={async () => {
              setAnnouncementBusy(true);
              setAnnouncementMessage(null);
              setError(null);
              try {
                const normalized = announcementDraft.replace(/\s+/g, " ").trim().slice(0, 512);
                await putAdminAnnouncement({ text: normalized });
                setAnnouncementDraft(normalized);
                setAnnouncementMessage("保存しました。ヘッダーに反映されます。");
                window.dispatchEvent(new Event("kakeibo:header-announcement-updated"));
              } catch (e) {
                setError(e instanceof Error ? e.message : "お知らせの保存に失敗しました");
              } finally {
                setAnnouncementBusy(false);
              }
            }}
          >
            {announcementBusy ? "保存中…" : "お知らせを保存"}
          </button>
          {announcementMessage ? (
            <span style={{ fontSize: "0.88rem", color: "var(--text-muted)" }}>{announcementMessage}</span>
          ) : null}
        </div>
      </div>
      <div
        style={{
          margin: "0.8rem 0 1rem",
          padding: "0.9rem 1rem",
          borderRadius: 12,
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
        }}
      >
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.02rem" }}>モニター募集設定</h2>
        <p style={{ margin: "0 0 0.65rem", fontSize: "0.88rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
          管理者向けのモニター募集案内をON/OFFできます。募集文は最大512文字です。
        </p>
        {monitorRecruitmentLoadError ? (
          <p style={{ margin: "0 0 0.55rem", fontSize: "0.86rem", color: "var(--danger, #c44)" }} role="alert">
            {monitorRecruitmentLoadError}
          </p>
        ) : null}
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
          <input
            type="checkbox"
            checked={monitorRecruitmentEnabled}
            disabled={monitorRecruitmentBusy || loading}
            onChange={(e) => setMonitorRecruitmentEnabled(e.target.checked)}
          />
          モニター募集を表示する
        </label>
        <textarea
          value={monitorRecruitmentText}
          onChange={(e) => setMonitorRecruitmentText(e.target.value)}
          maxLength={512}
          rows={2}
          disabled={monitorRecruitmentBusy || loading}
          placeholder="例: 新機能の先行モニターを募集しています。ご協力いただける方は管理者までご連絡ください。"
          style={{
            width: "100%",
            boxSizing: "border-box",
            font: "inherit",
            fontSize: "0.92rem",
            padding: "0.5rem 0.6rem",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--input-bg)",
            color: "var(--text)",
            resize: "vertical",
            minHeight: "3.2rem",
          }}
        />
        <div style={{ marginTop: "0.55rem", display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            disabled={monitorRecruitmentBusy || loading}
            onClick={async () => {
              setMonitorRecruitmentBusy(true);
              setMonitorRecruitmentMessage(null);
              setError(null);
              try {
                const normalized = monitorRecruitmentText.replace(/\s+/g, " ").trim().slice(0, 512);
                if (import.meta.env.DEV) {
                  // eslint-disable-next-line no-console
                  console.log("[Admin] save monitor recruitment (request)", {
                    enabled: monitorRecruitmentEnabled,
                    textLength: normalized.length,
                  });
                }
                const putOut = await putAdminMonitorRecruitmentSettings({
                  enabled: monitorRecruitmentEnabled,
                  text: normalized,
                });
                if (import.meta.env.DEV) {
                  // eslint-disable-next-line no-console
                  console.log("[Admin] save monitor recruitment (PUT result)", putOut);
                }
                const verify = await getAdminMonitorRecruitmentSettings();
                if (import.meta.env.DEV) {
                  // eslint-disable-next-line no-console
                  console.log("[Admin] save monitor recruitment (verify GET)", verify);
                }
                setMonitorRecruitmentEnabled(verify.enabled === true);
                setMonitorRecruitmentText(
                  typeof verify.text === "string" ? verify.text : normalized,
                );
                setMonitorRecruitmentLoadError(
                  verify.migrationMissing
                    ? "DB に db/migration_v25_monitor_recruitment_settings.sql が未適用の可能性があります。"
                    : null,
                );
                setMonitorRecruitmentMessage("保存しました。");
              } catch (e) {
                setError(e instanceof Error ? e.message : "モニター募集設定の保存に失敗しました");
              } finally {
                setMonitorRecruitmentBusy(false);
              }
            }}
          >
            {monitorRecruitmentBusy ? "保存中…" : "モニター募集設定を保存"}
          </button>
          {monitorRecruitmentMessage ? (
            <span
              style={{ fontSize: "0.88rem", color: "var(--accent)" }}
              role="status"
              aria-live="polite"
            >
              {monitorRecruitmentMessage}
            </span>
          ) : null}
        </div>
      </div>
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
            autoComplete="new-password"
            title={NEW_PASSWORD_TOOLTIP}
            placeholder={`初期パスワード（${NEW_PASSWORD_LABEL}）`}
            maxLength={128}
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
      <div
        style={{
          margin: "0.8rem 0 1rem",
          padding: "0.75rem 0.9rem",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--panel-bg)",
        }}
      >
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "0.98rem" }}>
          PayPay取込モニター（monitor_logs 集計）
        </h2>
        {paypayImportSummary.length === 0 ? (
          <>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>
              まだPayPay取込ログがありません（または migration v24 未適用）。
            </p>
            {paypayMonitorError ? (
              <p style={{ margin: "0.45rem 0 0", color: "#b42318", fontWeight: 600 }}>
                {paypayMonitorError}
              </p>
            ) : null}
          </>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 940 }}>
              <thead>
                <tr style={{ background: "var(--bg-card)" }}>
                  <th style={adminTableTh}>ユーザー</th>
                  <th style={adminTableTh}>実行回数</th>
                  <th style={adminTableTh}>総行数</th>
                  <th style={adminTableTh}>新規</th>
                  <th style={adminTableTh}>更新</th>
                  <th style={adminTableTh}>合算</th>
                  <th style={adminTableTh}>除外</th>
                  <th style={adminTableTh}>エラー</th>
                  <th style={adminTableTh}>最終取込</th>
                </tr>
              </thead>
              <tbody>
                {paypayImportSummary.map((r) => (
                  <tr key={`pp-${r.user_id}`} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={adminTableTd}>
                      {r.user_email ?? "—"}（ID: {r.user_id}）
                    </td>
                    <td style={adminTableTd}>{Number(r.run_count ?? 0)}</td>
                    <td style={adminTableTd}>{Number(r.total_rows ?? 0).toLocaleString("ja-JP")}</td>
                    <td style={adminTableTd}>{Number(r.new_count ?? 0).toLocaleString("ja-JP")}</td>
                    <td style={adminTableTd}>{Number(r.updated_count ?? 0).toLocaleString("ja-JP")}</td>
                    <td style={adminTableTd}>{Number(r.aggregated_count ?? 0).toLocaleString("ja-JP")}</td>
                    <td style={adminTableTd}>{Number(r.excluded_count ?? 0).toLocaleString("ja-JP")}</td>
                    <td style={adminTableTd}>{Number(r.error_count ?? 0).toLocaleString("ja-JP")}</td>
                    <td style={adminTableTd}>{formatDateTime(r.last_import_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {error ? <p style={{ color: "#b42318", fontWeight: 600 }}>{error}</p> : null}
      {!subscriptionStatusWritable ? (
        <p
          style={{
            margin: "0 0 0.65rem",
            padding: "0.55rem 0.75rem",
            borderRadius: 8,
            background: "var(--panel-bg)",
            border: "1px solid var(--border)",
            fontSize: "0.88rem",
            color: "var(--text-muted)",
          }}
        >
          <strong>サブスク状態の手動変更は利用できません。</strong>
          RDS の <code>users</code> に <code>subscription_status</code> 列がありません。{" "}
          <code>db/migration_v8_users_subscription_status.sql</code> を適用すると、一覧のプルダウンから変更できます。
        </p>
      ) : null}
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
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            minWidth: 1740,
            tableLayout: "auto",
          }}
        >
          <thead>
            <tr style={{ background: "var(--panel-bg)" }}>
              <th style={{ ...adminTableTh, width: "2.5rem" }}>ユーザーID</th>
              <th style={{ ...adminTableTh, minWidth: 260 }}>メール</th>
              <th style={adminTableTh}>登録日</th>
              <th style={adminTableTh}>最終ログイン</th>
              <th style={{ ...adminTableTh, minWidth: "5.5rem" }}>家族ID</th>
              <th style={{ ...adminTableTh, minWidth: "7rem" }}>役割</th>
              {/* width:1% + 子の nowrap で列幅を内容に寄せ、表示名列との隙間を詰める */}
              <th style={{ ...adminTableTh, width: "1%", whiteSpace: "nowrap" }}>家族メンバー</th>
              <th style={{ ...adminTableTh, minWidth: 180 }}>表示名</th>
              <th style={{ ...adminTableTh, minWidth: 100 }}>ログイン名</th>
              <th style={{ ...adminTableTh, minWidth: 150 }}>サブスク</th>
              <th style={adminTableTh}>管理者</th>
              <th style={adminTableTh}>パスワード</th>
              <th style={adminTableTh}>削除</th>
            </tr>
          </thead>
          <tbody>
            {familyGroups.flatMap((group) => {
              const familyTitle =
                group.familyId != null ? `家族ID ${group.familyId}` : `未所属（ユーザー ${group.members[0]?.id ?? "—"}）`;
              const familyLabelKey = group.familyId != null ? String(group.familyId) : group.familyKey;
              const familyLabel = (familyLabelDrafts[familyLabelKey] ?? "").trim();
              const parentRow = (
                <tr key={`family-${group.familyKey}`} style={{ borderTop: "2px solid var(--border)", background: "var(--panel-bg)" }}>
                  <td colSpan={13} style={{ ...adminTableTd, paddingTop: "0.45rem", paddingBottom: "0.45rem" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.8rem", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
                        <strong>{familyTitle}</strong>
                        <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                          メンバー {group.members.length}名
                        </span>
                        <input
                          type="text"
                          placeholder="家族ラベル（表示用）"
                          value={familyLabelDrafts[familyLabelKey] ?? ""}
                          onChange={(e) =>
                            setFamilyLabelDrafts((prev) => ({ ...prev, [familyLabelKey]: e.target.value }))
                          }
                          style={{ minWidth: 170, padding: "0.18rem 0.35rem", fontSize: "0.8rem" }}
                        />
                        {familyLabel ? (
                          <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                            ラベル: {familyLabel}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                </tr>
              );
              const memberRows = group.members.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>{u.id}</td>
                  <td style={{ ...adminTableTd, minWidth: 260, wordBreak: "break-all" }}>{u.email}</td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    {formatDateOnly(u.created_at)}
                  </td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    {formatDateTime(u.last_login_at)}
                  </td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      placeholder="—"
                      value={familyIdDrafts[u.id] ?? ""}
                      disabled={savingUserId === u.id}
                      onChange={(e) =>
                        setFamilyIdDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))
                      }
                      style={{ width: "4.5rem", padding: "0.2rem 0.35rem", fontSize: "0.8125rem" }}
                      title="既定の家族（families.id）。空欄で未所属にできます（要マイグレーション v18）。"
                    />
                  </td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", flexWrap: "nowrap", gap: "0.3rem", alignItems: "center" }}>
                      <select
                        value={familyRoleDrafts[u.id] ?? "MEMBER"}
                        disabled={savingUserId === u.id}
                        onChange={(e) =>
                          setFamilyRoleDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))
                        }
                        style={{ minWidth: 120, padding: "0.2rem 0.35rem", fontSize: "0.8125rem" }}
                        title="KID: 取引一覧は本人の登録分のみ表示（users.family_role）"
                      >
                        {ADMIN_FAMILY_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {FAMILY_ROLE_LABELS[r] ?? r}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={savingUserId === u.id}
                        onClick={() => {
                          void onApplyFamilySettings(u.id);
                        }}
                        style={adminTableBtn}
                      >
                        反映
                      </button>
                    </div>
                  </td>
                  <td
                    style={{
                      ...adminTableTd,
                      width: "1%",
                      paddingRight: "0.4rem",
                      verticalAlign: "middle",
                    }}
                  >
                    {group.memberLabelLines.length === 0 ? (
                      "—"
                    ) : (
                      <div style={{ lineHeight: 1.15 }}>
                        {group.memberLabelLines.map((line, i) => {
                          const currentName = (displayNameDrafts[u.id] ?? u.display_name ?? "").trim();
                          const isCurrent = currentName.length > 0 && line.includes(currentName);
                          return (
                            <div key={i} style={{ whiteSpace: "nowrap", fontWeight: isCurrent ? 700 : 400 }}>
                              {line}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td style={{ ...adminTableTd, paddingLeft: "0.35rem" }}>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "nowrap",
                        gap: "0.35rem",
                        alignItems: "center",
                        justifyContent: "flex-start",
                      }}
                    >
                      <input
                        type="text"
                        value={displayNameDrafts[u.id] ?? ""}
                        disabled={savingUserId === u.id}
                        onChange={(e) =>
                          setDisplayNameDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))
                        }
                        style={{ minWidth: 120, maxWidth: 160, padding: "0.2rem 0.35rem", fontSize: "0.8125rem" }}
                      />
                      <button
                        type="button"
                        disabled={savingUserId === u.id}
                        onClick={() => {
                          void onSaveDisplayName(u.id);
                        }}
                        style={adminTableBtn}
                      >
                        保存
                      </button>
                    </div>
                  </td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>{u.login_name ?? "-"}</td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    <select
                      value={u.subscriptionStatus ?? "inactive"}
                      disabled={savingUserId === u.id || !subscriptionStatusWritable}
                      onChange={(e) => {
                        void onSetSubscriptionStatus(u.id, e.target.value);
                      }}
                      style={{
                        minWidth: 150,
                        maxWidth: 220,
                        padding: "0.2rem 0.35rem",
                        fontSize: "0.8125rem",
                      }}
                      title={
                        !subscriptionStatusWritable
                          ? "subscription_status 列が無いため変更できません（v8 マイグレーションを適用してください）"
                          : undefined
                      }
                    >
                      {Array.from(
                        new Set([...ADMIN_SUBSCRIPTION_STATUSES, u.subscriptionStatus ?? "inactive"]),
                      )
                        .filter((s) => s.length > 0)
                        .sort((a, b) =>
                          subscriptionStatusLabelJa(a).localeCompare(
                            subscriptionStatusLabelJa(b),
                            "ja",
                          ),
                        )
                        .map((s) => (
                          <option key={s} value={s}>
                            {subscriptionStatusLabelJa(s)}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    <label style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
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
                  <td style={adminTableTd}>
                    <button
                      type="button"
                      disabled={savingUserId === u.id}
                      onClick={() => {
                        void onResetPassword(u.id, u.email);
                      }}
                      style={adminTableBtn}
                    >
                      初期化
                    </button>
                    {tempPasswords[u.id] ? (
                      <div
                        style={{
                          marginTop: "0.2rem",
                          color: "var(--text-muted)",
                          fontSize: "0.75rem",
                          lineHeight: 1.2,
                        }}
                      >
                        一時PW: <code>{tempPasswords[u.id]}</code>
                      </div>
                    ) : null}
                  </td>
                  <td style={adminTableTd}>
                    <button
                      type="button"
                      disabled={savingUserId === u.id}
                      onClick={() => {
                        void onDeleteUser(u.id, u.email);
                      }}
                      style={{ ...adminTableBtn, color: "#b42318" }}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ));
              return [parentRow, ...memberRows];
            })}
            {!loading && items.length === 0 ? (
              <tr>
                <td colSpan={13} style={{ padding: "1rem", color: "var(--text-muted)" }}>
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
