import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  createAdminUser,
  deleteAdminUser,
  getAdminAnnouncement,
  getAdminFeaturePermissions,
  getAdminMonitorRecruitmentSettings,
  getAdminPayPayImportSummary,
  getAdminSalesLogs,
  getAdminSalesDailySummaryWithFallback,
  getAdminSalesMonthlySummary,
  getAdminSubscriptionReconcile,
  getAdminUsers,
  getReconcileDismissedKeys,
  patchAdminFeaturePermission,
  postAdminSubscriptionReconcileApply,
  putAdminAnnouncement,
  setReconcileDismissedKeys,
  putAdminMonitorRecruitmentSettings,
  resetAdminUserPassword,
  updateAdminUser,
  downloadAdminSalesCsv,
  type AdminFeaturePermissionRow,
  type AdminSalesDailySummaryRow,
  type AdminSalesLogRow,
  type AdminSalesMonthlySummaryRow,
} from "../lib/api";
import { AdminSalesCharts } from "../components/AdminSalesCharts";
import { buildAdminSalesAdvancedAnalysis } from "../lib/adminSalesAdvancedAnalysis";
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
import apStyles from "./AdminPage.module.css";

function salesSourceTypeLabel(t: string | null | undefined): string {
  const s = String(t || "").trim();
  switch (s) {
    case "checkout_session":
      return "Checkout";
    case "invoice":
      return "請求";
    case "payment_intent":
      return "PI";
    case "refund":
      return "返金";
    default:
      return s || "—";
  }
}

function formatSalesNumber(n: number): string {
  return n.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

function salesSourceTypeClassName(t: string | null | undefined): string {
  const s = String(t || "").trim();
  const base = apStyles.salesKind;
  switch (s) {
    case "checkout_session":
      return `${base} ${apStyles.salesKindCheckout}`;
    case "invoice":
      return `${base} ${apStyles.salesKindInvoice}`;
    case "payment_intent":
      return `${base} ${apStyles.salesKindPi}`;
    case "refund":
      return `${base} ${apStyles.salesKindRefund}`;
    default:
      return `${base} ${apStyles.salesKindDefault}`;
  }
}

function familyMismatchKey(r: { familyId: number; stripeCustomerId: string }): string {
  return `f:${r.familyId}:${r.stripeCustomerId}`;
}

function userMismatchKey(r: { userId: number; familyId: number }): string {
  return `u:${r.userId}:${r.familyId}`;
}

/** API が返す英語の SQL エラーを、管理者向けに要約（is_premium / v9 は別番号であることを明記） */
function explainStripeReconcileLoadError(raw: string): {
  headline: string;
  bullets: string[];
  showRaw: boolean;
} {
  const t = String(raw ?? "").trim();
  if (
    /is_premium/i.test(t) ||
    /Unknown column/i.test(t) ||
    /field list/i.test(t) ||
    /ER_BAD_FIELD/i.test(t)
  ) {
    return {
      headline: "データベースに「プレミアム用の列（is_premium）」がまだありません。",
      bullets: [
        "表示の英語は MySQL のエラーで、「users テーブルに is_premium 列がない」という意味です。",
        "対応: マイグレーション v9（db/migration_v9_users_is_premium.sql）を本番の RDS に適用してください。v29 まで当てたこととは別の番号です。",
        "例: リポジトリの backend で `npm run db:migrate-v9`（RDS 接続の .env 設定が必要）。適用後、管理画面を再読み込みして照合を取り直してください。",
      ],
      showRaw: true,
    };
  }
  return {
    headline: "Stripe 照合のデータを取得できませんでした。",
    bullets: [
      t && t.length > 0
        ? t
        : "理由が取得できませんでした。本番 API の更新・STRIPE_SECRET_KEY・管理者権限を確認してください。",
    ],
    showRaw: t.length > 0,
  };
}

type AdminUser = {
  id: number;
  email: string;
  login_name: string | null;
  display_name: string | null;
  isAdmin: boolean;
  subscriptionStatus: string;
  created_at: string | null;
  updated_at: string | null;
  last_accessed_at?: string | null;
  login_device?: string | null;
  user_agent?: string | null;
  default_family_id: number | null;
  /** users.family_role（未対応 API では undefined） */
  familyRole?: string;
  family_peers: string | null;
};

function parseDeviceBadge(u: AdminUser): { icon: string; title: string } {
  const raw = `${u.login_device ?? ""} ${u.user_agent ?? ""}`.toLowerCase();
  if (!raw.trim()) return { icon: "❓", title: "不明（デバイス情報なし）" };

  const isTablet = /ipad|tablet|sm-t|tab|kindle|silk/.test(raw);
  const isMobile = !isTablet && /iphone|android|mobile|phone|pixel/.test(raw);
  const isPc = /windows|macintosh|mac os|linux|x11|desktop/.test(raw);

  const os =
    /windows/.test(raw)
      ? "Windows"
      : /iphone|ipad|ios/.test(raw)
        ? "iOS"
        : /android/.test(raw)
          ? "Android"
          : /mac os|macintosh/.test(raw)
            ? "macOS"
            : /linux/.test(raw)
              ? "Linux"
              : "不明OS";

  if (isTablet) return { icon: "📟", title: `タブレット (${os})` };
  if (isMobile) return { icon: "📱", title: `スマホ (${os})` };
  if (isPc) return { icon: "💻", title: `PC (${os})` };
  return { icon: "❓", title: `判別不能 (${os})` };
}

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

const adminTableThRight = { ...adminTableTh, textAlign: "right" as const };
const adminTableTdRight = { ...adminTableTd, textAlign: "right" as const };

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

function thisMonthDateRange() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const last = new Date(y, m + 1, 0).getDate();
  const to = `${y}-${String(m + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

export function AdminPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayNameDrafts, setDisplayNameDrafts] = useState<Record<number, string>>({});
  const [emailDrafts, setEmailDrafts] = useState<Record<number, string>>({});
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
  const [salesMonthlySummary, setSalesMonthlySummary] = useState<AdminSalesMonthlySummaryRow[]>([]);
  const [salesLogs, setSalesLogs] = useState<AdminSalesLogRow[]>([]);
  const [salesError, setSalesError] = useState<string | null>(null);
  const [salesFilterYm, setSalesFilterYm] = useState("");
  const monthRange = useMemo(() => thisMonthDateRange(), []);
  const [salesCsvFrom, setSalesCsvFrom] = useState(monthRange.from);
  const [salesCsvTo, setSalesCsvTo] = useState(monthRange.to);
  const [salesCsvBusy, setSalesCsvBusy] = useState(false);
  const [salesDaily, setSalesDaily] = useState<AdminSalesDailySummaryRow[]>([]);
  const [salesDailyLoading, setSalesDailyLoading] = useState(false);
  const [salesDailyError, setSalesDailyError] = useState<string | null>(null);
  /** 専用 API が 404 のとき明細から再集計した */
  const [salesDailyFromLogs, setSalesDailyFromLogs] = useState(false);
  /** 明細 API の 500 件上限に達した（フォールバック時の近似） */
  const [salesDailyLogsTruncated, setSalesDailyLogsTruncated] = useState(false);
  /** グラフ上の日次純利益目標（点線）— 任意 */
  const [salesChartTarget, setSalesChartTarget] = useState("");
  const [reconcileData, setReconcileData] = useState<Awaited<
    ReturnType<typeof getAdminSubscriptionReconcile>
  > | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileDismissed, setReconcileDismissed] = useState<string[]>(() => getReconcileDismissedKeys());
  const [reconcileApplyBusy, setReconcileApplyBusy] = useState<string | null>(null);
  const [featurePermRows, setFeaturePermRows] = useState<AdminFeaturePermissionRow[]>([]);
  const [featurePermError, setFeaturePermError] = useState<string | null>(null);
  const [featurePermSaving, setFeaturePermSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReconcileError(null);
    try {
      const [res, ann] = await Promise.all([
        getAdminUsers(),
        getAdminAnnouncement().catch(() => ({ text: "" })),
      ]);
      try {
        const rec = await getAdminSubscriptionReconcile();
        setReconcileData(rec);
      } catch (e) {
        setReconcileData(null);
        setReconcileError(
          e instanceof Error
            ? e.message
            : "Stripe 照合の取得に失敗しました（STRIPE_SECRET_KEY 未設定、または API 未デプロイの可能性）",
        );
      }
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
      const monthlySales = await getAdminSalesMonthlySummary().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setSalesError(msg && msg.trim() ? msg : "売上集計の取得に失敗しました。");
        return { items: [] as AdminSalesMonthlySummaryRow[] };
      });
      const sales = await getAdminSalesLogs({ ym: salesFilterYm || undefined }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setSalesError(msg && msg.trim() ? msg : "売上明細の取得に失敗しました。");
        return { items: [] as AdminSalesLogRow[] };
      });
      const list = Array.isArray(res.items) ? res.items : [];
      setFeaturePermError(null);
      try {
        const fp = await getAdminFeaturePermissions();
        setFeaturePermRows(Array.isArray(fp.items) ? fp.items : []);
      } catch (e) {
        setFeaturePermRows([]);
        setFeaturePermError(e instanceof Error ? e.message : String(e));
      }
      setItems(list);
      if (Array.isArray(monitor.items)) {
        setPaypayMonitorError(null);
      }
      if (Array.isArray(monthlySales.items) && Array.isArray(sales.items)) {
        setSalesError(null);
      }
      setPaypayImportSummary(Array.isArray(monitor.items) ? monitor.items : []);
      setSalesMonthlySummary(Array.isArray(monthlySales.items) ? monthlySales.items : []);
      setSalesLogs(Array.isArray(sales.items) ? sales.items : []);
      setSubscriptionStatusWritable(res.meta?.subscriptionStatusWritable !== false);
      setDisplayNameDrafts(
        Object.fromEntries(
          list.map((u) => [u.id, u.display_name ?? ""]),
        ),
      );
      setEmailDrafts(
        Object.fromEntries(
          list.map((u) => [u.id, u.email ?? ""]),
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
      setReconcileData(null);
      setError(formatAdminApiError(e));
    } finally {
      setLoading(false);
    }
  }, [salesFilterYm]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(salesCsvFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(salesCsvTo)) {
      setSalesDailyError("グラフ: 開始日・終了日を有効な日付にしてください。");
      setSalesDaily([]);
      return;
    }
    if (salesCsvFrom > salesCsvTo) {
      setSalesDailyError("グラフ: 開始日は終了日以前にしてください。");
      setSalesDaily([]);
      return;
    }
    let cancelled = false;
    setSalesDailyLoading(true);
    setSalesDailyError(null);
    setSalesDailyFromLogs(false);
    setSalesDailyLogsTruncated(false);
    getAdminSalesDailySummaryWithFallback({ from: salesCsvFrom, to: salesCsvTo })
      .then((r) => {
        if (cancelled) return;
        setSalesDaily(Array.isArray(r.items) ? r.items : []);
        setSalesDailyFromLogs(r.usedLogsFallback);
        setSalesDailyLogsTruncated(r.salesLogsHitRowCap);
      })
      .catch((e) => {
        if (cancelled) return;
        setSalesDaily([]);
        setSalesDailyError(
          formatAdminApiError(e).replace(
            "ユーザー一覧の取得に失敗しました",
            "日次集計（グラフ）の取得に失敗しました。",
          ),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setSalesDailyLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [salesCsvFrom, salesCsvTo]);

  const adminCount = useMemo(() => items.filter((x) => x.isAdmin).length, [items]);
  const salesSummaryTotals = useMemo(() => {
    return salesMonthlySummary.reduce(
      (acc, row) => {
        acc.gross += Number(row.gross_total ?? 0);
        acc.fee += Number(row.fee_total ?? 0);
        acc.net += Number(row.net_total ?? 0);
        return acc;
      },
      { gross: 0, fee: 0, net: 0 },
    );
  }, [salesMonthlySummary]);

  const salesChartTargetNetY = useMemo((): number | null => {
    const t = salesChartTarget.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }, [salesChartTarget]);

  const salesAdvanced = useMemo(() => {
    if (salesMonthlySummary.length === 0) return null;
    return buildAdminSalesAdvancedAnalysis({
      monthlySummary: salesMonthlySummary,
      salesLogs,
      selectedYm: salesFilterYm,
    });
  }, [salesMonthlySummary, salesLogs, salesFilterYm]);

  const visibleFamilyMismatches = useMemo(() => {
    if (!reconcileData) return [];
    return reconcileData.familyMismatches.filter(
      (r) => !reconcileDismissed.includes(familyMismatchKey(r)),
    );
  }, [reconcileData, reconcileDismissed]);

  const visibleUserMismatches = useMemo(() => {
    if (!reconcileData) return [];
    return reconcileData.userMismatches.filter(
      (r) => !reconcileDismissed.includes(userMismatchKey(r)),
    );
  }, [reconcileData, reconcileDismissed]);

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

  const onSaveEmail = useCallback(
    async (userId: number) => {
      setSavingUserId(userId);
      setError(null);
      try {
        const next = (emailDrafts[userId] ?? "").trim().toLowerCase();
        if (!next || !next.includes("@") || /\s/.test(next)) {
          setError("有効なメールアドレスを入力してください。");
          return;
        }
        await updateAdminUser(userId, { email: next });
        setItems((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, email: next } : u)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "メールアドレス更新に失敗しました");
      } finally {
        setSavingUserId(null);
      }
    },
    [emailDrafts],
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

  const onDownloadSalesCsv = useCallback(async () => {
    setSalesCsvBusy(true);
    setSalesError(null);
    try {
      const out = await downloadAdminSalesCsv({
        from: salesCsvFrom || undefined,
        to: salesCsvTo || undefined,
      });
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.filename || "sales-report.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setSalesError(e instanceof Error ? e.message : "売上CSVの出力に失敗しました");
    } finally {
      setSalesCsvBusy(false);
    }
  }, [salesCsvFrom, salesCsvTo]);

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
          margin: "0.75rem 0 1rem",
          padding: "0.9rem 1rem",
          borderRadius: 12,
          border: "1px solid var(--border)",
          background: "var(--bg-card)",
        }}
      >
        <h2 style={{ margin: "0 0 0.45rem", fontSize: "1.02rem" }}>機能権限（プラン）</h2>
        <p style={{ margin: "0 0 0.55rem", fontSize: "0.84rem", color: "var(--text-muted)", lineHeight: 1.45 }}>
          機能ごとに<strong>最小プラン</strong>を設定します。Standard＝ログイン済みユーザーが利用可。Premium＝プレミアム契約（既存の課金判定）が必要です。
        </p>
        {featurePermError ? (
          <p role="alert" style={{ fontSize: "0.86rem", color: "var(--danger, #b44)" }}>
            {featurePermError}
          </p>
        ) : featurePermRows.length === 0 ? (
          <p style={{ fontSize: "0.86rem", color: "var(--text-muted)" }}>
            データがありません。RDS に <code>db/migration_v32_feature_permissions.sql</code>（v32）を適用してください。
          </p>
        ) : (
          <div className={apStyles.featurePermScroll}>
            <table className={apStyles.featurePermTable}>
              <thead>
                <tr>
                  <th
                    className={apStyles.featurePermColFeature}
                    style={{
                      ...adminTableTh,
                      whiteSpace: "normal",
                    }}
                  >
                    機能
                  </th>
                  <th className={apStyles.featurePermColKey} style={adminTableTh}>
                    キー
                  </th>
                  <th className={apStyles.featurePermColPlan} style={adminTableTh}>
                    最小プラン
                  </th>
                </tr>
              </thead>
              <tbody>
                {featurePermRows.map((r) => {
                  const fk = String(r.feature_key);
                  const busy = featurePermSaving === fk;
                  const isStd = String(r.min_plan).toLowerCase() === "standard";
                  return (
                    <tr key={fk}>
                      <td
                        className={apStyles.featurePermColFeature}
                        style={adminTableTd}
                      >
                        {r.label_ja ?? fk}
                      </td>
                      <td
                        className={apStyles.featurePermColKey}
                        style={{
                          ...adminTableTd,
                          fontFamily: "ui-monospace, monospace",
                          wordBreak: "break-all",
                        }}
                      >
                        {fk}
                      </td>
                      <td className={apStyles.featurePermColPlan} style={adminTableTd}>
                        <div className={apStyles.featurePermPlanRow}>
                          <button
                            type="button"
                            className={apStyles.featurePermPlanBtn}
                            disabled={loading || busy || isStd}
                            onClick={async () => {
                              setFeaturePermSaving(fk);
                              setError(null);
                              try {
                                await patchAdminFeaturePermission({ feature_key: fk, min_plan: "standard" });
                                setFeaturePermRows((prev) =>
                                  prev.map((x) => (x.feature_key === fk ? { ...x, min_plan: "standard" } : x)),
                                );
                              } catch (e) {
                                setError(e instanceof Error ? e.message : "権限の更新に失敗しました");
                              } finally {
                                setFeaturePermSaving(null);
                              }
                            }}
                            style={{
                              font: "inherit",
                              fontSize: "0.78rem",
                              padding: "0.25rem 0.55rem",
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              background: isStd ? "color-mix(in srgb, var(--accent) 22%, var(--bg-card))" : "var(--input-bg)",
                              cursor: isStd ? "default" : "pointer",
                            }}
                          >
                            Standard
                          </button>
                          <button
                            type="button"
                            className={apStyles.featurePermPlanBtn}
                            disabled={loading || busy || !isStd}
                            onClick={async () => {
                              setFeaturePermSaving(fk);
                              setError(null);
                              try {
                                await patchAdminFeaturePermission({ feature_key: fk, min_plan: "premium" });
                                setFeaturePermRows((prev) =>
                                  prev.map((x) => (x.feature_key === fk ? { ...x, min_plan: "premium" } : x)),
                                );
                              } catch (e) {
                                setError(e instanceof Error ? e.message : "権限の更新に失敗しました");
                              } finally {
                                setFeaturePermSaving(null);
                              }
                            }}
                            style={{
                              font: "inherit",
                              fontSize: "0.78rem",
                              padding: "0.25rem 0.55rem",
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              background: !isStd ? "color-mix(in srgb, var(--accent) 22%, var(--bg-card))" : "var(--input-bg)",
                              cursor: !isStd ? "default" : "pointer",
                            }}
                          >
                            Premium
                          </button>
                          {busy ? <span style={{ fontSize: "0.75rem" }}>保存中…</span> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {reconcileError != null && reconcileError !== "" && (() => {
        const help = explainStripeReconcileLoadError(reconcileError);
        return (
          <div
            role="alert"
            style={{
              margin: "0.75rem 0",
              padding: "0.75rem 0.9rem",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "color-mix(in srgb, var(--warning) 12%, var(--bg-card))",
              fontSize: "0.88rem",
              lineHeight: 1.55,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: "0.45rem" }}>Stripe 照合が使えません</div>
            <p style={{ margin: "0 0 0.5rem", fontWeight: 600, color: "var(--text)" }}>{help.headline}</p>
            <ol
              style={{
                margin: 0,
                paddingLeft: "1.25rem",
                color: "var(--text)",
              }}
            >
              {help.bullets.map((line, i) => (
                <li key={i} style={{ marginTop: i > 0 ? "0.35rem" : 0 }}>
                  {line}
                </li>
              ))}
            </ol>
            {help.showRaw ? (
              <details style={{ marginTop: "0.65rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                <summary style={{ cursor: "pointer" }}>元の技術メッセージ（英語）を表示</summary>
                <pre
                  style={{
                    margin: "0.4rem 0 0",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {reconcileError}
                </pre>
              </details>
            ) : null}
          </div>
        );
      })()}
      {reconcileData && (
        <div
          style={{
            margin: "0.75rem 0 1rem",
            padding: "0.9rem 1rem",
            borderRadius: 12,
            border: `1px solid ${
              reconcileData.hasMismatches || reconcileData.userPremiumCheckSkipped
                ? "color-mix(in srgb, #c00 35%, var(--border))"
                : "var(--border)"
            }`,
            background:
              reconcileData.hasMismatches || reconcileData.userPremiumCheckSkipped
                ? "color-mix(in srgb, #c00 6%, var(--bg-card))"
                : "var(--bg-card)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.5rem",
              marginBottom: "0.4rem",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.02rem" }}>Stripe と DB のサブスク照合</h2>
            <button
              type="button"
              disabled={loading}
              onClick={() => void load()}
              style={{ font: "inherit", fontSize: "0.86rem", padding: "0.3rem 0.65rem" }}
            >
              照合を再取得
            </button>
          </div>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.82rem", color: "var(--text-muted)" }}>
            表示は読み込み時点のライブ照合です。Stripe
            サブスクリプション件数: {reconcileData.stripeSubscriptionCount} ／ 課金
            cus_ 付き家族行: {reconcileData.familyRowCount} ／ 取得時刻: {reconcileData.at}
          </p>
          {reconcileData.userPremiumCheckSkipped && reconcileData.userPremiumSkipReasonJa ? (
            <p
              style={{
                margin: "0 0 0.6rem",
                fontSize: "0.86rem",
                lineHeight: 1.5,
                padding: "0.5rem 0.65rem",
                borderRadius: 8,
                background: "color-mix(in srgb, #fa0 10%, var(--bg-card))",
                border: "1px solid color-mix(in srgb, #fa0 35%, var(--border))",
              }}
            >
              {reconcileData.userPremiumSkipReasonJa}
            </p>
          ) : null}
          {reconcileData.hasMismatches ? (
            <>
              <p style={{ margin: "0 0 0.55rem", fontWeight: 600, color: "var(--text)" }}>
                不整合が検出されました。行ごとに、DBをStripeに揃えて更新するか、この画面の一覧からだけ一時的に隠すか、選べます（CLI
                バッチや通知メールの利用も従来どおり可能です）。
              </p>
              {reconcileDismissed.length > 0 ? (
                <p style={{ margin: "0 0 0.55rem", display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
                  <span style={{ fontSize: "0.83rem" }}>
                    一覧から一時的に隠した行: {reconcileDismissed.length} 件
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setReconcileDismissed([]);
                      setReconcileDismissedKeys([]);
                    }}
                    style={{ font: "inherit", fontSize: "0.83rem" }}
                  >
                    不整合行を再表示
                  </button>
                </p>
              ) : null}
              {reconcileData.familyMismatches.length > 0 && visibleFamilyMismatches.length === 0 ? (
                <p style={{ margin: "0 0 0.6rem", fontSize: "0.86rem", color: "var(--text-muted)" }}>
                  家族の不整合行は、すべて「表示から外す」で非表示にしています。上の「不整合行を再表示」で戻せます。
                </p>
              ) : null}
              {reconcileData.userMismatches.length > 0 && visibleUserMismatches.length === 0 ? (
                <p style={{ margin: "0 0 0.6rem", fontSize: "0.86rem", color: "var(--text-muted)" }}>
                  プレミアム不整合行は、すべて「表示から外す」で非表示にしています。
                </p>
              ) : null}
              {visibleFamilyMismatches.length > 0 && (
                <div style={{ marginBottom: "0.75rem" }}>
                  <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.35rem" }}>家族（families）の契約状態</h3>
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: "0.78rem",
                      }}
                    >
                      <thead>
                        <tr>
                          <th style={adminTableTh}>家族ID</th>
                          <th style={adminTableTh}>Stripe 顧客ID (cus_)</th>
                          <th style={adminTableTh}>DB 上の状態</th>
                          <th style={adminTableTh}>Stripe 上の想定</th>
                          <th style={adminTableTh}>代表サブスク</th>
                          <th style={adminTableTh}>内容</th>
                          <th style={adminTableTh}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleFamilyMismatches.map((row) => {
                          const fKey = familyMismatchKey(row);
                          const busy = reconcileApplyBusy === fKey;
                          return (
                            <tr key={fKey}>
                              <td style={adminTableTd}>{row.familyId}</td>
                              <td style={{ ...adminTableTd, wordBreak: "break-all" }}>{row.stripeCustomerId}</td>
                              <td style={adminTableTd}>{subscriptionStatusLabelJa(row.db)}</td>
                              <td style={adminTableTd}>{subscriptionStatusLabelJa(row.stripeExpected)}</td>
                              <td style={{ ...adminTableTd, wordBreak: "break-all" }}>
                                {row.stripeBestSubscriptionId ?? "—"}
                              </td>
                              <td style={adminTableTd}>
                                {row.descriptionJa ?? "—"}
                              </td>
                              <td style={adminTableTd}>
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                                  <button
                                    type="button"
                                    disabled={loading || busy}
                                    onClick={async () => {
                                      if (
                                        !window.confirm(
                                          "この家族（families）の契約状態を、現在の Stripe の内容に合わせて更新します。よろしいですか？",
                                        )
                                      ) {
                                        return;
                                      }
                                      setReconcileApplyBusy(fKey);
                                      setError(null);
                                      try {
                                        await postAdminSubscriptionReconcileApply({
                                          kind: "family",
                                          familyId: row.familyId,
                                        });
                                        setReconcileDismissed((d) => {
                                          const n = d.filter((x) => x !== fKey);
                                          setReconcileDismissedKeys(n);
                                          return n;
                                        });
                                        await load();
                                      } catch (e) {
                                        setError(
                                          e instanceof Error
                                            ? e.message
                                            : "契約状態の更新に失敗しました",
                                        );
                                      } finally {
                                        setReconcileApplyBusy(null);
                                      }
                                    }}
                                    style={{ font: "inherit", fontSize: "0.75rem" }}
                                  >
                                    {busy ? "更新中…" : "DBに反映（Stripe基準）"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={loading || busy}
                                    onClick={() => {
                                      setReconcileDismissed((prev) => {
                                        const n = prev.includes(fKey) ? prev : [...prev, fKey];
                                        setReconcileDismissedKeys(n);
                                        return n;
                                      });
                                    }}
                                    style={{ font: "inherit", fontSize: "0.75rem" }}
                                  >
                                    表示から外す
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {visibleUserMismatches.length > 0 && (
                <div>
                  <h3 style={{ fontSize: "0.9rem", margin: "0 0 0.35rem" }}>ユーザーのプレミアム表示（is_premium）</h3>
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: "0.78rem",
                      }}
                    >
                      <thead>
                        <tr>
                          <th style={adminTableTh}>ユーザーID</th>
                          <th style={adminTableTh}>家族ID</th>
                          <th style={adminTableTh}>顧客ID (cus_)</th>
                          <th style={adminTableTh}>説明</th>
                          <th style={adminTableTh}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleUserMismatches.map((row) => {
                          const uKey = userMismatchKey(row);
                          const busy = reconcileApplyBusy === uKey;
                          return (
                            <tr key={uKey}>
                              <td style={adminTableTd}>{row.userId}</td>
                              <td style={adminTableTd}>{row.familyId}</td>
                              <td style={{ ...adminTableTd, wordBreak: "break-all" }}>{row.stripeCustomerId}</td>
                              <td style={adminTableTd}>
                                {row.descriptionJa ?? row.note ?? "—"}
                              </td>
                              <td style={adminTableTd}>
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                                  <button
                                    type="button"
                                    disabled={loading || busy}
                                    onClick={async () => {
                                      if (
                                        !window.confirm(
                                          "該当ユーザーのプレミアム（DB）を契約状況に合わせてオフに揃えます。よろしいですか？",
                                        )
                                      ) {
                                        return;
                                      }
                                      setReconcileApplyBusy(uKey);
                                      setError(null);
                                      try {
                                        await postAdminSubscriptionReconcileApply({
                                          kind: "user",
                                          familyId: row.familyId,
                                          userId: row.userId,
                                        });
                                        setReconcileDismissed((d) => {
                                          const n = d.filter((x) => x !== uKey);
                                          setReconcileDismissedKeys(n);
                                          return n;
                                        });
                                        await load();
                                      } catch (e) {
                                        setError(
                                          e instanceof Error
                                            ? e.message
                                            : "更新に失敗しました",
                                        );
                                      } finally {
                                        setReconcileApplyBusy(null);
                                      }
                                    }}
                                    style={{ font: "inherit", fontSize: "0.75rem" }}
                                  >
                                    {busy ? "更新中…" : "DBに反映（プレミアム解消）"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={loading || busy}
                                    onClick={() => {
                                      setReconcileDismissed((prev) => {
                                        const n = prev.includes(uKey) ? prev : [...prev, uKey];
                                        setReconcileDismissedKeys(n);
                                        return n;
                                      });
                                    }}
                                    style={{ font: "inherit", fontSize: "0.75rem" }}
                                  >
                                    表示から外す
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-muted)" }}>
              不整合はありません（家族・ユーザーの照合範囲内）。
            </p>
          )}
        </div>
      )}
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
          padding: "0.75rem 0.9rem",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--panel-bg)",
        }}
      >
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "0.98rem" }}>
          Stripe売上管理（税理士提出用）
        </h2>
        <p style={{ margin: "0 0 0.5rem", color: "var(--text-muted)", fontSize: "0.86rem" }}>
          payments 相当データは <code>sales_logs</code> から集計しています（総額・手数料・純利益）。
        </p>
        {salesError ? (
          <p style={{ margin: "0.35rem 0 0.6rem", color: "#b42318", fontWeight: 600 }}>{salesError}</p>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end", marginBottom: "0.65rem" }}>
          <label style={{ display: "grid", gap: "0.2rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>明細表示月（YYYY-MM）</span>
            <input
              type="month"
              value={salesFilterYm}
              onChange={(e) => setSalesFilterYm(e.target.value)}
              style={{ font: "inherit", padding: "0.25rem 0.4rem" }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              void load();
            }}
            disabled={loading}
            style={{ height: 34 }}
          >
            再集計
          </button>
        </div>
        <div className={apStyles.salesKpiRow}>
          <div className={apStyles.salesKpiCard}>
            24か月総売上: <strong>{formatSalesNumber(salesSummaryTotals.gross)}</strong>
          </div>
          <div className={apStyles.salesKpiCard}>
            24か月総手数料: <strong>{formatSalesNumber(salesSummaryTotals.fee)}</strong>
          </div>
          <div className={apStyles.salesKpiCard}>
            24か月純利益:{" "}
            <strong
              className={
                salesSummaryTotals.net < 0
                  ? apStyles.salesNetNeg
                  : salesSummaryTotals.net > 0
                    ? apStyles.salesNetPos
                    : undefined
              }
            >
              {formatSalesNumber(salesSummaryTotals.net)}
            </strong>
          </div>
        </div>
        <h3 style={{ margin: "0.4rem 0 0.35rem", fontSize: "0.92rem" }}>純利益の推移（日次）</h3>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "end",
            gap: "0.65rem",
            marginBottom: "0.4rem",
          }}
        >
          <span
            style={{
              fontSize: "0.78rem",
              color: "var(--text-muted)",
              width: "100%",
            }}
          >
            期間（下の税理士提出用 CSV 出力と同じ開始日・終了日です。変更するとグラフだけ非同期で再集計されます）
          </span>
          <label style={{ display: "grid", gap: "0.15rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>開始日</span>
            <input
              type="date"
              value={salesCsvFrom}
              onChange={(e) => setSalesCsvFrom(e.target.value)}
              style={{ font: "inherit", padding: "0.25rem 0.4rem" }}
            />
          </label>
          <label style={{ display: "grid", gap: "0.15rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>終了日</span>
            <input
              type="date"
              value={salesCsvTo}
              onChange={(e) => setSalesCsvTo(e.target.value)}
              style={{ font: "inherit", padding: "0.25rem 0.4rem" }}
            />
          </label>
          <label style={{ display: "grid", gap: "0.15rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>日次純利益の目標（任意・点線）</span>
            <input
              type="number"
              value={salesChartTarget}
              onChange={(e) => setSalesChartTarget(e.target.value)}
              placeholder="例: 5000"
              min={0}
              step={100}
              style={{ font: "inherit", padding: "0.25rem 0.4rem", maxWidth: 140 }}
            />
          </label>
        </div>
        {salesDailyFromLogs && !salesDailyError ? (
          <p
            style={{
              margin: "0 0 0.5rem",
              padding: "0.45rem 0.6rem",
              fontSize: "0.84rem",
              lineHeight: 1.45,
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "color-mix(in srgb, var(--warning, #b45309) 10%, var(--panel-bg, #fff))",
              color: "var(--text)",
            }}
          >
            日次専用 API（<code>/admin/payments/daily-summary</code>）が利用できないため、明細を日付別に合算して表示しています。バックエンドを最新版にデプロイすると専用集計に切り替わります。
            {salesDailyLogsTruncated
              ? " 明細の取得は最大 500 件のため、取引が多い期間はグラフが実際の合計より小さくなることがあります。"
              : ""}
          </p>
        ) : null}
        <AdminSalesCharts
          from={salesCsvFrom}
          to={salesCsvTo}
          items={salesDaily}
          loading={salesDailyLoading}
          error={salesDailyError}
          targetNetY={salesChartTargetNetY}
          advanced={salesAdvanced}
        />
        <div style={{ overflowX: "auto", marginBottom: "0.8rem" }}>
          <table
            className={apStyles.salesDataTable}
            style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}
          >
            <thead>
              <tr style={{ background: "var(--bg-card)" }}>
                <th style={adminTableTh}>月</th>
                <th className={apStyles.salesNumCell} style={adminTableThRight}>
                  件数
                </th>
                <th className={apStyles.salesNumCell} style={adminTableThRight}>
                  総額
                </th>
                <th className={apStyles.salesNumCell} style={adminTableThRight}>
                  手数料
                </th>
                <th className={apStyles.salesNumCell} style={adminTableThRight}>
                  純利益
                </th>
              </tr>
            </thead>
            <tbody>
              {salesMonthlySummary.map((r) => {
                const netM = Number(r.net_total ?? 0);
                return (
                  <tr
                    key={`sales-month-${r.ym}`}
                    className={apStyles.salesDataRow}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td style={adminTableTd}>{r.ym}</td>
                    <td className={apStyles.salesNumCell} style={adminTableTdRight}>
                      {Number(r.sales_count ?? 0).toLocaleString("ja-JP")}
                    </td>
                    <td className={apStyles.salesNumCell} style={adminTableTdRight}>
                      {formatSalesNumber(Number(r.gross_total ?? 0))}
                    </td>
                    <td className={apStyles.salesNumCell} style={adminTableTdRight}>
                      {formatSalesNumber(Number(r.fee_total ?? 0))}
                    </td>
                    <td
                      className={[
                        apStyles.salesNumCell,
                        netM < 0
                          ? apStyles.salesNetNeg
                          : netM > 0
                            ? apStyles.salesNetPos
                            : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={adminTableTdRight}
                    >
                      {formatSalesNumber(netM)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ overflowX: "auto", marginBottom: "0.8rem" }}>
          <table
            className={apStyles.salesDataTable}
            style={{ width: "100%", borderCollapse: "collapse", minWidth: 1040 }}
          >
            <thead>
              <tr style={{ background: "var(--bg-card)" }}>
                <th style={adminTableTh}>日時</th>
                <th style={adminTableTh}>種別</th>
                <th style={adminTableTh}>ユーザー</th>
                <th style={adminTableTh}>家族</th>
                <th className={apStyles.salesNumCell} style={adminTableThRight}>
                  総額
                </th>
                <th className={apStyles.salesNumCell} style={adminTableThRight}>
                  手数料
                </th>
                <th className={apStyles.salesNumCell} style={adminTableThRight}>
                  純利益
                </th>
                <th style={adminTableTh}>通貨</th>
              </tr>
            </thead>
            <tbody>
              {salesLogs.map((r) => {
                const netL = Number(r.net_amount ?? 0);
                return (
                  <tr
                    key={`sales-log-${r.id}`}
                    className={apStyles.salesDataRow}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <td style={adminTableTd}>{formatDateTime(r.occurred_at)}</td>
                    <td style={adminTableTd}>
                      <span className={salesSourceTypeClassName(r.stripe_source_type)}>
                        {salesSourceTypeLabel(r.stripe_source_type)}
                      </span>
                    </td>
                    <td style={adminTableTd}>
                      {r.user_email ?? "—"}（ID:{r.user_id ?? "—"}）
                    </td>
                    <td style={adminTableTd}>
                      {r.family_name ?? "—"}（ID:{r.family_id ?? "—"}）
                    </td>
                    <td className={apStyles.salesNumCell} style={adminTableTdRight}>
                      {formatSalesNumber(Number(r.gross_amount ?? 0))}
                    </td>
                    <td className={apStyles.salesNumCell} style={adminTableTdRight}>
                      {formatSalesNumber(Number(r.stripe_fee_amount ?? 0))}
                    </td>
                    <td
                      className={[
                        apStyles.salesNumCell,
                        netL < 0
                          ? apStyles.salesNetNeg
                          : netL > 0
                            ? apStyles.salesNetPos
                            : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={adminTableTdRight}
                    >
                      {formatSalesNumber(netL)}
                    </td>
                    <td style={adminTableTd}>{String(r.currency ?? "").toUpperCase() || "JPY"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ display: "grid", gap: "0.2rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>CSV開始日</span>
            <input type="date" value={salesCsvFrom} onChange={(e) => setSalesCsvFrom(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: "0.2rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>CSV終了日</span>
            <input type="date" value={salesCsvTo} onChange={(e) => setSalesCsvTo(e.target.value)} />
          </label>
          <button type="button" onClick={() => void onDownloadSalesCsv()} disabled={salesCsvBusy}>
            {salesCsvBusy ? "CSV生成中..." : "税理士提出用CSVを出力"}
          </button>
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
                  ID {u.id} — {u.email}（最終アクセス: {formatDateTime(u.last_accessed_at)})
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
            minWidth: 1790,
            tableLayout: "auto",
          }}
        >
          <thead>
            <tr style={{ background: "var(--panel-bg)" }}>
              <th style={{ ...adminTableTh, width: "2.5rem" }}>ユーザーID</th>
              <th style={{ ...adminTableTh, minWidth: 260 }}>メール</th>
              <th style={adminTableTh}>登録日</th>
              <th style={adminTableTh}>最終ログイン</th>
              <th style={{ ...adminTableTh, textAlign: "center" }}>接続</th>
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
              const parentRow = (
                <tr key={`family-${group.familyKey}`} style={{ borderTop: "2px solid var(--border)", background: "var(--panel-bg)" }}>
                  <td colSpan={14} style={{ ...adminTableTd, paddingTop: "0.45rem", paddingBottom: "0.45rem" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.8rem", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
                        <strong>{familyTitle}</strong>
                        <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                          メンバー {group.members.length}名
                        </span>
                      </div>
                    </div>
                  </td>
                </tr>
              );
              const memberRows = group.members.map((u) => {
                const device = parseDeviceBadge(u);
                return (
                <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>{u.id}</td>
                  <td style={{ ...adminTableTd, minWidth: 260 }}>
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
                        type="email"
                        value={emailDrafts[u.id] ?? ""}
                        disabled={savingUserId === u.id}
                        onChange={(e) =>
                          setEmailDrafts((prev) => ({ ...prev, [u.id]: e.target.value }))
                        }
                        style={{ minWidth: 200, maxWidth: 280, padding: "0.2rem 0.35rem", fontSize: "0.8125rem" }}
                      />
                      <button
                        type="button"
                        disabled={savingUserId === u.id}
                        onClick={() => {
                          void onSaveEmail(u.id);
                        }}
                        style={adminTableBtn}
                      >
                        保存
                      </button>
                    </div>
                  </td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    {formatDateOnly(u.created_at)}
                  </td>
                  <td style={{ ...adminTableTd, whiteSpace: "nowrap" }}>
                    {formatDateTime(u.last_accessed_at)}
                  </td>
                  <td
                    style={{
                      ...adminTableTd,
                      textAlign: "center",
                      width: "2.8rem",
                      minWidth: "2.8rem",
                    }}
                    title={device.title}
                  >
                    <span aria-label={device.title}>{device.icon}</span>
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
                    {(() => {
                      const currentName = (displayNameDrafts[u.id] ?? u.display_name ?? "").trim();
                      if (!currentName) return "—";
                      const currentLine = group.memberLabelLines.find((line) => line.includes(currentName));
                      const lineLower = String(currentLine ?? "").toLowerCase();
                      const roleLabel = lineLower.includes("owner") ? "オーナー" : "メンバー";
                      return (
                        <div style={{ lineHeight: 1.15 }}>
                          <div style={{ whiteSpace: "nowrap", fontWeight: 700 }}>
                            {currentName} : {roleLabel}
                          </div>
                        </div>
                      );
                    })()}
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
              );
              });
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
