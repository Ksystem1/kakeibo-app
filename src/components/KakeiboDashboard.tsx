import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getEffectiveFixedCostsForMonth, useSettings } from "../context/SettingsContext";
import {
  filterCategoriesForTransactionSelect,
  isReservedLedgerFixedCostCategoryName,
} from "../lib/transactionCategories";
import {
  createTransaction,
  deleteTransaction,
  deleteTransactionsBulk,
  ensureDefaultCategories,
  getApiBaseUrl,
  getCategories,
  getFamilyMembers,
  getMonthSummary,
  getTransactions,
  ledgerKidWatchApiOptionsFromSearch,
  type MedicalType,
  normalizeFamilyRole,
  updateTransaction,
} from "../lib/api";
import styles from "./KakeiboDashboard.module.css";

type Category = {
  id: number;
  name: string;
  kind: string;
  is_medical_default?: number | boolean;
  default_medical_type?: MedicalType | null;
  default_patient_name?: string | null;
};

type Transaction = {
  id: number;
  category_id: number | null;
  kind: string;
  amount: string | number;
  transaction_date: string;
  memo: string | null;
  is_medical_expense?: number | boolean;
  medical_type?: MedicalType | null;
  medical_patient_name?: string | null;
};

const MEDICAL_TYPE_LABELS: Record<MedicalType, string> = {
  treatment: "診療・治療",
  medicine: "医薬品",
  other: "その他",
};

function ymToRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonthParam(search: string): string | null {
  const p = new URLSearchParams(search).get("month");
  return p && /^\d{4}-\d{2}$/.test(p) ? p : null;
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

/** 通貨記号まわりの空白をノーブレーク化し、カード内で金額が途中改行されにくくする */
function formatYenSingleLine(n: number) {
  return yen.format(n).replace(/\s/g, "\u00a0");
}

const SUMMARY_AMOUNTS_VISIBLE_KEY = "kakeibo_summary_amounts_visible";

function readSummaryAmountsVisible(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = localStorage.getItem(SUMMARY_AMOUNTS_VISIBLE_KEY);
    if (v === null) return true;
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
}

function numAmount(v: string | number) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** 取引一覧の日付を YYYY-MM-DD のみ表示 */
function formatTxDateYmd(raw: string | Date | null | undefined) {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : raw.toISOString?.() ?? String(raw);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** スマホ向け: MM/DD（例: 04/03） */
function formatTxDateMd(raw: string | Date | null | undefined) {
  const ymd = formatTxDateYmd(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (m) return `${m[2]}/${m[3]}`;
  return ymd;
}

/** 編集用: MM/DD 入力 → YYYY-MM-DD（年は現在の取引日から継承） */
function parseMdToYmd(md: string, yearSourceYmd: string) {
  const y = /^(\d{4})/.exec(yearSourceYmd)?.[1];
  if (!y) return null;
  const m = /^(\d{1,2})[/.](\d{1,2})$/.exec(md.trim());
  if (!m) return null;
  const mo = Number.parseInt(m[1], 10);
  const d = Number.parseInt(m[2], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function yearOptions() {
  const cy = new Date().getFullYear();
  const out: number[] = [];
  for (let yy = cy - 5; yy <= cy + 2; yy += 1) out.push(yy);
  return out;
}

export type KakeiboLedgerMode = "default" | "kidAllowance";

type FamilyMemberRow = {
  id: number;
  display_name: string | null;
  email: string;
  family_role?: string;
  familyRole?: string;
  kid_theme?: string | null;
  kidTheme?: string | null;
};

function memberRowFamilyRoleRaw(x: FamilyMemberRow): unknown {
  return x.family_role ?? x.familyRole;
}

function memberRowHasKidTheme(x: FamilyMemberRow): boolean {
  const t = String(x.kid_theme ?? x.kidTheme ?? "").trim().toLowerCase();
  return (
    t === "pink" ||
    t === "lavender" ||
    t === "pastel_yellow" ||
    t === "mint_green" ||
    t === "floral" ||
    t === "blue" ||
    t === "navy" ||
    t === "dino_green" ||
    t === "space_black" ||
    t === "sky_red"
  );
}

/** 見守り用の子候補。KID / kid_theme 設定、またはロール列欠落時は自分以外を暫定表示 */
function pickKidMemberRowsForWatch(items: FamilyMemberRow[], selfId: number | undefined) {
  const normItems: FamilyMemberRow[] = items.map((x) => ({
    ...x,
    id: typeof x.id === "number" ? x.id : Number(x.id),
    family_role: String(memberRowFamilyRoleRaw(x) ?? "").trim() || undefined,
  }));

  const kids = normItems.filter((x) => normalizeFamilyRole(memberRowFamilyRoleRaw(x)) === "KID");
  if (kids.length > 0) return kids;

  const byKidTheme = normItems.filter((x) => memberRowHasKidTheme(x));
  if (byKidTheme.length > 0) return byKidTheme;

  const allMissing =
    normItems.length > 0 &&
    normItems.every((x) => {
      const raw = memberRowFamilyRoleRaw(x);
      return raw == null || String(raw).trim() === "";
    });
  if (allMissing && selfId != null) {
    return normItems.filter((x) => Number(x.id) !== Number(selfId));
  }
  return [];
}

type KakeiboDashboardProps = {
  /** kidAllowance: 子ども向けおこづかい帳（見出し・一部の親向けセクションを省略） */
  ledgerMode?: KakeiboLedgerMode;
};

export function KakeiboDashboard(props?: KakeiboDashboardProps) {
  const { ledgerMode = "default" } = props ?? {};
  const isKidAllowance = ledgerMode === "kidAllowance";
  const { user } = useAuth();
  const { fixedCostsByMonth } = useSettings();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const base = getApiBaseUrl();
  const txMobileNarrow = useMediaQuery("(max-width: 768px)");
  const [ym, setYm] = useState(() => parseMonthParam(location.search) ?? currentYm());
  const isParentForKidWatch = useMemo(() => {
    if (isKidAllowance) return false;
    const r = normalizeFamilyRole(user?.familyRole);
    return r === "ADMIN" || r === "MEMBER";
  }, [isKidAllowance, user?.familyRole]);
  const kidLedgerOpts = useMemo(() => {
    if (!isParentForKidWatch) return undefined;
    return ledgerKidWatchApiOptionsFromSearch(location.search);
  }, [isParentForKidWatch, location.search]);
  const kidWatchOn = Boolean(kidLedgerOpts);
  const selectedKidUserId =
    kidLedgerOpts?.kidUserId != null && Number.isFinite(kidLedgerOpts.kidUserId)
      ? kidLedgerOpts.kidUserId
      : null;
  const [kidMemberRows, setKidMemberRows] = useState<FamilyMemberRow[]>([]);
  /** 親向けで家族メンバーAPIの結果を一度反映済み（この間は kidMemberRows が [] でも「未確定」） */
  const [kidMemberListLoaded, setKidMemberListLoaded] = useState(false);
  const [summaryAmountsVisible, setSummaryAmountsVisible] = useState(readSummaryAmountsVisible);
  const loadSeqRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<{
    expenseTotal: unknown;
    incomeTotal: unknown;
    fixedCostFromSettings?: unknown;
    netMonthlyBalance?: unknown;
    expensesByCategory: Array<{
      category_id: number | null;
      category_name: string | null;
      total: unknown;
    }>;
    incomesByCategory: Array<{
      category_id: number | null;
      category_name: string | null;
      total: unknown;
    }>;
  } | null>(null);

  const { from, to } = useMemo(() => ymToRange(ym), [ym]);

  useEffect(() => {
    const m = parseMonthParam(location.search);
    if (m) setYm((prev) => (prev === m ? prev : m));
  }, [location.search]);

  useEffect(() => {
    if (kidWatchOn) {
      setEdit(null);
      setMobileEditDateText("");
    }
  }, [kidWatchOn]);

  function navigateWithSearch(mutate: (p: URLSearchParams) => void) {
    const p = new URLSearchParams(location.search);
    mutate(p);
    const s = p.toString();
    routerNavigate({ pathname: location.pathname, search: s ? `?${s}` : "" }, { replace: true });
  }

  const categoryById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories) {
      const id = typeof c.id === "number" ? c.id : Number(c.id);
      if (Number.isFinite(id)) m.set(id, c.name);
    }
    return m;
  }, [categories]);

  const categoryMedicalDefaultsById = useMemo(() => {
    const m = new Map<
      number,
      { isDefault: boolean; medicalType: MedicalType | null; patientName: string | null }
    >();
    for (const c of categories) {
      const id = typeof c.id === "number" ? c.id : Number(c.id);
      if (!Number.isFinite(id)) continue;
      const mt = c.default_medical_type;
      m.set(id, {
        isDefault: c.is_medical_default === true || Number(c.is_medical_default) === 1,
        medicalType: mt === "treatment" || mt === "medicine" || mt === "other" ? mt : null,
        patientName: c.default_patient_name ? String(c.default_patient_name) : null,
      });
    }
    return m;
  }, [categories]);

  /** 一覧のカテゴリ列が最長の表示ラベルに収まるよう 1ch 単位で渡す */
  const txCategoryMinCh = useMemo(() => {
    let m = "カテゴリ".length;
    for (const c of categories) {
      m = Math.max(m, c.name.length);
    }
    for (const t of transactions) {
      let label: string;
      if (t.category_id != null) {
        const cid =
          typeof t.category_id === "number"
            ? t.category_id
            : Number(t.category_id);
        label = Number.isFinite(cid)
          ? (categoryById.get(cid) ?? `ID:${cid}`)
          : "—";
      } else {
        label = "—";
      }
      m = Math.max(m, label.length);
    }
    return m;
  }, [categories, transactions, categoryById]);

  function normalizeCategoryRows(raw: unknown[]): Category[] {
    const out: Category[] = [];
    for (const row of raw) {
      const c = row as Record<string, unknown>;
      const idRaw = c.id;
      const id =
        typeof idRaw === "number" ? idRaw : Number(idRaw);
      if (!Number.isFinite(id) || id <= 0) continue;
      out.push({
        id,
        name: String(c.name ?? ""),
        kind:
          String(c.kind ?? "").toLowerCase() === "income"
            ? "income"
            : "expense",
        is_medical_default:
          c.is_medical_default === true || Number(c.is_medical_default ?? 0) === 1,
        default_medical_type:
          c.default_medical_type === "treatment" ||
          c.default_medical_type === "medicine" ||
          c.default_medical_type === "other"
            ? (c.default_medical_type as MedicalType)
            : null,
        default_patient_name:
          c.default_patient_name == null ? null : String(c.default_patient_name),
      });
    }
    return out;
  }

  const load = useCallback(async () => {
    if (!base) {
      setError("VITE_API_URL が未設定です。.env を確認してください。");
      return;
    }
    const seq = ++loadSeqRef.current;
    setError(null);
    setLoading(true);
    try {
      let catRes = await getCategories();
      let items = catRes.items ?? [];
      if (items.length === 0) {
        try {
          await ensureDefaultCategories();
          catRes = await getCategories();
          items = catRes.items ?? [];
        } catch {
          /* 古い API では POST が無い場合がある */
        }
      }
      if (seq !== loadSeqRef.current) return;
      const familyFetchOpts = {
        scope: "family" as const,
        ...(kidLedgerOpts ?? {}),
      };
      const [txRes, sumRes, memRes] = await Promise.all([
        getTransactions(from, to, familyFetchOpts),
        getMonthSummary(ym, familyFetchOpts),
        isParentForKidWatch ? getFamilyMembers() : Promise.resolve(null),
      ]);
      if (seq !== loadSeqRef.current) return;
      setCategories(normalizeCategoryRows(items));
      const fetchedTransactions = (txRes.items ?? []) as Transaction[];
      const activeEl = typeof document !== "undefined" ? document.activeElement : null;
      const isEditingFieldFocused =
        activeEl instanceof HTMLElement &&
        (activeEl.tagName.toLowerCase() === "input" || activeEl.tagName.toLowerCase() === "textarea") &&
        activeEl.closest(`.${styles.txTable}`) != null;
      if (isEditingFieldFocused) {
        setTransactions((prev) => prev);
      } else {
        setTransactions(fetchedTransactions);
      }
      setSummary(sumRes);
      if (memRes && isParentForKidWatch) {
        const memItems = (memRes.items ?? []) as FamilyMemberRow[];
        setKidMemberRows(pickKidMemberRowsForWatch(memItems, user?.id));
        setKidMemberListLoaded(true);
      } else if (!isParentForKidWatch) {
        setKidMemberRows([]);
        setKidMemberListLoaded(false);
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setTransactions([]);
      setSummary(null);
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [base, from, to, ym, kidLedgerOpts, isParentForKidWatch, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 子ども未登録時はお小遣い帳モードのクエリを外す（一覧にトグルを出さないため） */
  useEffect(() => {
    if (!isParentForKidWatch || loading) return;
    if (!kidMemberListLoaded) return;
    if (kidMemberRows.length > 0) return;
    const p = new URLSearchParams(location.search);
    if (!p.get("kidWatch")) return;
    p.delete("kidWatch");
    p.delete("kidUser");
    const s = p.toString();
    routerNavigate({ pathname: location.pathname, search: s ? `?${s}` : "" }, { replace: true });
  }, [
    isParentForKidWatch,
    kidMemberListLoaded,
    kidMemberRows.length,
    loading,
    location.pathname,
    location.search,
    routerNavigate,
  ]);

  useEffect(() => {
    try {
      localStorage.setItem(SUMMARY_AMOUNTS_VISIBLE_KEY, summaryAmountsVisible ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [summaryAmountsVisible]);

  function handleMonthChange(nextYm: string) {
    setYm(nextYm);
    const params = new URLSearchParams(location.search);
    params.set("month", nextYm);
    routerNavigate(
      {
        pathname: location.pathname,
        search: `?${params.toString()}`,
      },
      { replace: true },
    );
  }

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const t of transactions) {
      const a = numAmount(t.amount);
      if (t.kind === "income") income += a;
      else if (t.kind === "expense") {
        if (t.category_id != null) {
          const cid =
            typeof t.category_id === "number" ? t.category_id : Number(t.category_id);
          const nm = Number.isFinite(cid) ? categoryById.get(cid) : undefined;
          if (isReservedLedgerFixedCostCategoryName(nm)) continue;
        }
        expense += a;
      }
    }
    return { income, expense, balance: income - expense };
  }, [transactions, categoryById]);

  const incomeTotalNum = summary
    ? numAmount(summary.incomeTotal as string | number)
    : totals.income;
  const expenseTotalNum = summary
    ? numAmount(summary.expenseTotal as string | number)
    : totals.expense;
  const fixedCostItemsForMonth = getEffectiveFixedCostsForMonth(fixedCostsByMonth, ym);
  const fixedCostForMonth = fixedCostItemsForMonth.reduce((acc, x) => acc + Number(x.amount || 0), 0);
  const fixedCostForSpend =
    Number.isFinite(fixedCostForMonth) && fixedCostForMonth > 0 ? fixedCostForMonth : 0;
  /** 収入も変動費も0の月は固定費を支出合計に含めない。見守りモードでは親の固定費を絶対に混ぜない */
  const applyFixedToSpend =
    !kidWatchOn && (incomeTotalNum > 0 || expenseTotalNum > 0);
  /** カード「支出（今月）」: 収入または変動費がある月は設定の固定費月額を加算 */
  const expenseWithFixedDisplayNum =
    expenseTotalNum + (applyFixedToSpend ? fixedCostForSpend : 0);
  const balanceNum = (() => {
    if (!summary) {
      const useFixed = !kidWatchOn && (totals.income > 0 || totals.expense > 0);
      return totals.income - totals.expense - (useFixed ? fixedCostForSpend : 0);
    }
    const apiNet = numAmount(summary.netMonthlyBalance as string | number);
    if (Number.isFinite(apiNet)) return apiNet;
    return (
      incomeTotalNum -
      expenseTotalNum -
      (applyFixedToSpend ? fixedCostForSpend : 0)
    );
  })();
  const expenseRowsOrdered = useMemo(() => {
    const rows = [...(summary?.expensesByCategory ?? [])];
    rows.sort(
      (a, b) =>
        numAmount(b.total as string | number) - numAmount(a.total as string | number),
    );
    return rows;
  }, [summary?.expensesByCategory]);

  const hasExpenseApiSection =
    !isKidAllowance && Boolean(summary) && expenseRowsOrdered.length > 0;
  const hasFixedCostSection =
    !isKidAllowance && !kidWatchOn && fixedCostItemsForMonth.length > 0;
  const hasIncomeApiSection =
    !isKidAllowance &&
    Boolean(summary) &&
    (summary?.incomesByCategory?.length ?? 0) > 0;
  const hasSummaryApiGrid = hasExpenseApiSection || hasFixedCostSection || hasIncomeApiSection;
  /** 3カラム同時表示時: Subgridで見出し・説明・表の行を揃える */
  const summaryApiThreeUp =
    hasExpenseApiSection && hasFixedCostSection && hasIncomeApiSection;

  const [formAmount, setFormAmount] = useState("");
  const [formKind, setFormKind] = useState<"expense" | "income">("expense");
  const [formDate, setFormDate] = useState(todayDate);
  const [formMemo, setFormMemo] = useState("");
  const [formCategoryId, setFormCategoryId] = useState<string>("");
  const [formIsMedicalExpense, setFormIsMedicalExpense] = useState(false);
  const [formMedicalType, setFormMedicalType] = useState<MedicalType | "">("");
  const [formMedicalPatientName, setFormMedicalPatientName] = useState("");
  const [saving, setSaving] = useState(false);

  const [edit, setEdit] = useState<{
    id: number;
    kind: "expense" | "income";
    amount: string;
    transaction_date: string;
    memo: string;
    category_id: string;
    is_medical_expense: boolean;
    medical_type: MedicalType | "";
    medical_patient_name: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  /** モバイル編集時の日付（MM/DD）。ネイティブ date の yyyy/mm/dd 表示を避ける */
  const [mobileEditDateText, setMobileEditDateText] = useState("");
  const [expenseCategoryModal, setExpenseCategoryModal] = useState<{
    categoryId: number | null;
    categoryName: string;
  } | null>(null);
  const [modalLineEdit, setModalLineEdit] = useState<{
    id: number;
    kind: "expense" | "income";
    amount: string;
    transaction_date: string;
    memo: string;
    category_id: string;
    is_medical_expense: boolean;
    medical_type: MedicalType | "";
    medical_patient_name: string;
  } | null>(null);
  const [modalEditSaving, setModalEditSaving] = useState(false);
  const [fixedCostExpanded, setFixedCostExpanded] = useState(false);
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);
  const [selectedTxIds, setSelectedTxIds] = useState<number[]>([]);
  const [bulkDeleteMessage, setBulkDeleteMessage] = useState<string | null>(null);
  const mobileFixedCostInitialRows = 6;
  const txInitialRows = 5;
  const visibleFixedCostItems = useMemo(() => {
    if (!txMobileNarrow) return fixedCostItemsForMonth;
    if (fixedCostExpanded) return fixedCostItemsForMonth;
    return fixedCostItemsForMonth.slice(0, mobileFixedCostInitialRows);
  }, [txMobileNarrow, fixedCostExpanded, fixedCostItemsForMonth]);
  const visibleTransactions = useMemo(() => {
    if (transactionsExpanded) return transactions;
    return transactions.slice(0, txInitialRows);
  }, [transactionsExpanded, transactions]);
  const visibleTransactionIds = useMemo(
    () => visibleTransactions.map((t) => Number(t.id)).filter((id) => Number.isFinite(id) && id > 0),
    [visibleTransactions],
  );
  const selectedVisibleCount = useMemo(
    () => visibleTransactionIds.filter((id) => selectedTxIds.includes(id)).length,
    [visibleTransactionIds, selectedTxIds],
  );
  const allVisibleSelected = visibleTransactionIds.length > 0 && selectedVisibleCount === visibleTransactionIds.length;
  const selectedCount = selectedTxIds.length;

  const expenseCategoryModalTx = useMemo(() => {
    if (!expenseCategoryModal) return [];
    const target = expenseCategoryModal.categoryId;
    return transactions
      .filter((t) => {
        if (String(t.kind).toLowerCase() !== "expense") return false;
        if (target == null) {
          if (t.category_id == null) return true;
          const n = typeof t.category_id === "number" ? t.category_id : Number(t.category_id);
          return !Number.isFinite(n);
        }
        const n = typeof t.category_id === "number" ? t.category_id : Number(t.category_id);
        return Number.isFinite(n) && n === target;
      })
      .sort((a, b) => {
        const da = String(a.transaction_date);
        const db = String(b.transaction_date);
        if (db !== da) return db.localeCompare(da);
        return b.id - a.id;
      });
  }, [expenseCategoryModal, transactions]);

  const showMedicalCsvNotice = useMemo(() => {
    if (!expenseCategoryModal) return false;
    const name = expenseCategoryModal.categoryName;
    if (name.includes("医療")) return true;
    const fid = expenseCategoryModal.categoryId;
    if (fid != null) {
      const d = categoryMedicalDefaultsById.get(fid);
      if (d?.isDefault) return true;
    }
    return expenseCategoryModalTx.some(
      (t) => t.is_medical_expense === true || Number(t.is_medical_expense) === 1,
    );
  }, [expenseCategoryModal, expenseCategoryModalTx, categoryMedicalDefaultsById]);

  useEffect(() => {
    setTransactionsExpanded(false);
  }, [ym]);

  useEffect(() => {
    setSelectedTxIds((prev) => prev.filter((id) => transactions.some((t) => Number(t.id) === id)));
  }, [transactions]);

  useEffect(() => {
    if (kidWatchOn) setModalLineEdit(null);
  }, [kidWatchOn]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number.parseFloat(formAmount);
    const minAmount = formKind === "income" ? 0 : 1;
    if (!Number.isFinite(amount) || amount < minAmount) {
      setError(
        formKind === "income"
          ? "収入は 0 以上で入力してください。"
          : "支出は 1 以上で入力してください。",
      );
      return;
    }
    if (formKind === "expense" && formCategoryId) {
      const cid = Number.parseInt(formCategoryId, 10);
      const cat = categories.find((c) => c.id === cid);
      if (cat && isReservedLedgerFixedCostCategoryName(cat.name)) {
        setError("「固定費」は取引では選べません。設定画面の固定費を利用してください。");
        return;
      }
    }
    if (formKind === "expense" && formIsMedicalExpense && !formMedicalType) {
      setError("医療費控除の区分を選択してください。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createTransaction({
        kind: formKind,
        amount,
        transaction_date: formDate,
        memo: formMemo.trim() || null,
        category_id: formCategoryId
          ? Number.parseInt(formCategoryId, 10)
          : null,
        is_medical_expense: formKind === "expense" ? formIsMedicalExpense : false,
        medical_type: formKind === "expense" && formIsMedicalExpense ? formMedicalType : null,
        medical_patient_name:
          formKind === "expense" && formIsMedicalExpense
            ? formMedicalPatientName.trim() || null
            : null,
      });
      setFormAmount("");
      setFormMemo("");
      setFormIsMedicalExpense(false);
      setFormMedicalType("");
      setFormMedicalPatientName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const filteredCategories = filterCategoriesForTransactionSelect(
    categories.filter((c) => c.kind === formKind),
  );
  const editCategories = filterCategoriesForTransactionSelect(
    categories.filter((c) => c.kind === (edit?.kind ?? "expense")),
  );
  const modalEditCategories = filterCategoriesForTransactionSelect(
    categories.filter((c) => c.kind === (modalLineEdit?.kind ?? "expense")),
  );

  /** 一覧に出ない／固定費の ID が value に残るとブラウザが誤表示することがあるためクリア */
  useEffect(() => {
    if (!formCategoryId) return;
    const id = Number.parseInt(formCategoryId, 10);
    if (!Number.isFinite(id)) return;
    const cat = categories.find((c) => c.id === id);
    if (!cat || cat.kind !== formKind || isReservedLedgerFixedCostCategoryName(cat.name)) {
      setFormCategoryId("");
    }
  }, [categories, formKind, formCategoryId]);

  function applyMedicalDefaultsToAddForm(nextCategoryId: string, nextKind: "expense" | "income") {
    if (nextKind !== "expense") {
      setFormIsMedicalExpense(false);
      setFormMedicalType("");
      setFormMedicalPatientName("");
      return;
    }
    const cid = Number.parseInt(nextCategoryId, 10);
    if (!Number.isFinite(cid)) {
      setFormIsMedicalExpense(false);
      setFormMedicalType("");
      setFormMedicalPatientName("");
      return;
    }
    const defaults = categoryMedicalDefaultsById.get(cid);
    if (!defaults?.isDefault || !defaults.medicalType) {
      setFormIsMedicalExpense(false);
      setFormMedicalType("");
      setFormMedicalPatientName("");
      return;
    }
    setFormIsMedicalExpense(true);
    setFormMedicalType(defaults.medicalType);
    setFormMedicalPatientName(defaults.patientName ?? "");
  }

  function applyMedicalDefaultsToEdit(nextCategoryId: string, nextKind: "expense" | "income") {
    if (!edit) return;
    if (nextKind !== "expense") {
      setEdit({
        ...edit,
        kind: nextKind,
        category_id: nextCategoryId,
        is_medical_expense: false,
        medical_type: "",
        medical_patient_name: "",
      });
      return;
    }
    const cid = Number.parseInt(nextCategoryId, 10);
    const defaults = Number.isFinite(cid) ? categoryMedicalDefaultsById.get(cid) : null;
    if (!defaults?.isDefault || !defaults.medicalType) {
      setEdit({
        ...edit,
        kind: nextKind,
        category_id: nextCategoryId,
        is_medical_expense: false,
        medical_type: "",
        medical_patient_name: "",
      });
      return;
    }
    setEdit({
      ...edit,
      kind: nextKind,
      category_id: nextCategoryId,
      is_medical_expense: true,
      medical_type: defaults.medicalType,
      medical_patient_name: defaults.patientName ?? "",
    });
  }

  function applyMedicalDefaultsToModalLineEdit(
    nextCategoryId: string,
    nextKind: "expense" | "income",
  ) {
    if (!modalLineEdit) return;
    if (nextKind !== "expense") {
      setModalLineEdit({
        ...modalLineEdit,
        kind: nextKind,
        category_id: nextCategoryId,
        is_medical_expense: false,
        medical_type: "",
        medical_patient_name: "",
      });
      return;
    }
    const cid = Number.parseInt(nextCategoryId, 10);
    const defaults = Number.isFinite(cid) ? categoryMedicalDefaultsById.get(cid) : null;
    if (!defaults?.isDefault || !defaults.medicalType) {
      setModalLineEdit({
        ...modalLineEdit,
        kind: nextKind,
        category_id: nextCategoryId,
        is_medical_expense: false,
        medical_type: "",
        medical_patient_name: "",
      });
      return;
    }
    setModalLineEdit({
      ...modalLineEdit,
      kind: nextKind,
      category_id: nextCategoryId,
      is_medical_expense: true,
      medical_type: defaults.medicalType,
      medical_patient_name: defaults.patientName ?? "",
    });
  }

  function beginEdit(t: Transaction) {
    const ymd = formatTxDateYmd(t.transaction_date);
    let categoryIdStr = t.category_id != null ? String(t.category_id) : "";
    if (t.kind === "expense" && t.category_id != null) {
      const cid =
        typeof t.category_id === "number" ? t.category_id : Number(t.category_id);
      const nm = Number.isFinite(cid) ? categoryById.get(cid) : undefined;
      if (isReservedLedgerFixedCostCategoryName(nm)) categoryIdStr = "";
    }
    setEdit({
      id: t.id,
      kind: t.kind === "income" ? "income" : "expense",
      amount: String(numAmount(t.amount)),
      transaction_date: ymd,
      memo: t.memo ?? "",
      category_id: categoryIdStr,
      is_medical_expense: t.is_medical_expense === true || Number(t.is_medical_expense) === 1,
      medical_type:
        t.medical_type === "treatment" || t.medical_type === "medicine" || t.medical_type === "other"
          ? t.medical_type
          : "",
      medical_patient_name: t.medical_patient_name ? String(t.medical_patient_name) : "",
    });
    setMobileEditDateText(formatTxDateMd(t.transaction_date));
  }

  function cancelEdit() {
    setEdit(null);
    setMobileEditDateText("");
  }

  function beginModalLineEdit(t: Transaction) {
    if (kidWatchOn) return;
    const ymd = formatTxDateYmd(t.transaction_date);
    let categoryIdStr = t.category_id != null ? String(t.category_id) : "";
    if (t.kind === "expense" && t.category_id != null) {
      const cid =
        typeof t.category_id === "number" ? t.category_id : Number(t.category_id);
      const nm = Number.isFinite(cid) ? categoryById.get(cid) : undefined;
      if (isReservedLedgerFixedCostCategoryName(nm)) categoryIdStr = "";
    }
    setModalLineEdit({
      id: t.id,
      kind: t.kind === "income" ? "income" : "expense",
      amount: String(numAmount(t.amount)),
      transaction_date: ymd,
      memo: t.memo ?? "",
      category_id: categoryIdStr,
      is_medical_expense: t.is_medical_expense === true || Number(t.is_medical_expense) === 1,
      medical_type:
        t.medical_type === "treatment" || t.medical_type === "medicine" || t.medical_type === "other"
          ? t.medical_type
          : "",
      medical_patient_name: t.medical_patient_name ? String(t.medical_patient_name) : "",
    });
  }

  function cancelModalLineEdit() {
    setModalLineEdit(null);
  }

  async function saveModalLineEdit() {
    if (!modalLineEdit) return;
    if (kidWatchOn) return;
    const amount = Number.parseFloat(modalLineEdit.amount);
    const minAmount = modalLineEdit.kind === "income" ? 0 : 1;
    if (!Number.isFinite(amount) || amount < minAmount) {
      setError(
        modalLineEdit.kind === "income"
          ? "収入は 0 以上で入力してください。"
          : "支出は 1 以上で入力してください。",
      );
      return;
    }
    if (modalLineEdit.kind === "expense" && modalLineEdit.category_id) {
      const cid = Number.parseInt(modalLineEdit.category_id, 10);
      const cat = categories.find((c) => c.id === cid);
      if (cat && isReservedLedgerFixedCostCategoryName(cat.name)) {
        setError("「固定費」は取引では選べません。設定画面の固定費を利用してください。");
        return;
      }
    }
    if (modalLineEdit.kind === "expense" && modalLineEdit.is_medical_expense && !modalLineEdit.medical_type) {
      setError("医療費控除の区分を選択してください。");
      return;
    }
    setModalEditSaving(true);
    setError(null);
    try {
      await updateTransaction(modalLineEdit.id, {
        kind: modalLineEdit.kind,
        amount,
        transaction_date: modalLineEdit.transaction_date,
        memo: modalLineEdit.memo.trim() || null,
        category_id: modalLineEdit.category_id
          ? Number.parseInt(modalLineEdit.category_id, 10)
          : null,
        is_medical_expense: modalLineEdit.kind === "expense" ? modalLineEdit.is_medical_expense : false,
        medical_type:
          modalLineEdit.kind === "expense" && modalLineEdit.is_medical_expense
            ? modalLineEdit.medical_type
            : null,
        medical_patient_name:
          modalLineEdit.kind === "expense" && modalLineEdit.is_medical_expense
            ? modalLineEdit.medical_patient_name.trim() || null
            : null,
      });
      cancelModalLineEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setModalEditSaving(false);
    }
  }

  async function saveEdit() {
    if (!edit) return;
    const amount = Number.parseFloat(edit.amount);
    const minAmount = edit.kind === "income" ? 0 : 1;
    if (!Number.isFinite(amount) || amount < minAmount) {
      setError(
        edit.kind === "income"
          ? "収入は 0 以上で入力してください。"
          : "支出は 1 以上で入力してください。",
      );
      return;
    }
    if (edit.kind === "expense" && edit.category_id) {
      const cid = Number.parseInt(edit.category_id, 10);
      const cat = categories.find((c) => c.id === cid);
      if (cat && isReservedLedgerFixedCostCategoryName(cat.name)) {
        setError("「固定費」は取引では選べません。設定画面の固定費を利用してください。");
        return;
      }
    }
    if (edit.kind === "expense" && edit.is_medical_expense && !edit.medical_type) {
      setError("医療費控除の区分を選択してください。");
      return;
    }
    setEditSaving(true);
    setError(null);
    try {
      await updateTransaction(edit.id, {
        kind: edit.kind,
        amount,
        transaction_date: edit.transaction_date,
        memo: edit.memo.trim() || null,
        category_id: edit.category_id
          ? Number.parseInt(edit.category_id, 10)
          : null,
        is_medical_expense: edit.kind === "expense" ? edit.is_medical_expense : false,
        medical_type:
          edit.kind === "expense" && edit.is_medical_expense ? edit.medical_type : null,
        medical_patient_name:
          edit.kind === "expense" && edit.is_medical_expense
            ? edit.medical_patient_name.trim() || null
            : null,
      });
      cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSaving(false);
    }
  }

  async function removeTransaction(id: number) {
    if (!window.confirm("この取引を削除しますか？")) return;
    setError(null);
    try {
      await deleteTransaction(id);
      setSelectedTxIds((prev) => prev.filter((x) => x !== id));
      setBulkDeleteMessage("1件削除しました。");
      if (edit?.id === id) cancelEdit();
      if (modalLineEdit?.id === id) setModalLineEdit(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleSelectOne(id: number, checked: boolean) {
    setSelectedTxIds((prev) => {
      if (checked) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  }

  function toggleSelectAllVisible(checked: boolean) {
    if (!checked) {
      setSelectedTxIds((prev) => prev.filter((id) => !visibleTransactionIds.includes(id)));
      return;
    }
    setSelectedTxIds((prev) => [...new Set([...prev, ...visibleTransactionIds])]);
  }

  async function removeSelectedTransactions() {
    const ids = [...new Set(selectedTxIds)].filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length === 0) return;
    if (!window.confirm(`選択した${ids.length}件の明細を削除しますか？`)) return;
    setError(null);
    try {
      const res = await deleteTransactionsBulk(ids);
      setSelectedTxIds([]);
      setBulkDeleteMessage(`${res.deleted}件削除しました。`);
      if (edit && ids.includes(edit.id)) cancelEdit();
      if (modalLineEdit && ids.includes(modalLineEdit.id)) setModalLineEdit(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const closeExpenseCategoryModal = useCallback(() => {
    setExpenseCategoryModal(null);
    setModalLineEdit(null);
  }, []);

  useEffect(() => {
    if (!expenseCategoryModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeExpenseCategoryModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expenseCategoryModal, closeExpenseCategoryModal]);

  return (
    <>
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {isKidAllowance
              ? "おこづかい帳"
              : kidWatchOn
                ? "お小遣い帳（見守り）"
                : "家計簿"}
          </h1>
          {isKidAllowance ? (
            <p className={styles.sub} style={{ marginTop: "0.35rem", maxWidth: "36rem" }}>
              自分の入出金と残金です。保護者やきょうだいとは「家族チャット」からメッセージできます。
            </p>
          ) : null}
          {kidWatchOn ? (
            <p className={styles.sub} style={{ marginTop: "0.35rem", maxWidth: "40rem", color: "#5b21b6" }}>
              家族内の KID が登録した取引のみを表示しています（閲覧のみ・ここからの追加・編集・削除はできません）。スイッチをオフにすると夫婦の家計簿に戻ります。
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          <label htmlFor={txMobileNarrow ? undefined : "kb-month"} className={styles.monthRow}>
            表示月
            {txMobileNarrow ? (
              <span className={styles.monthPickerMobile}>
                <select
                  className={styles.monthSelect}
                  aria-label="表示年"
                  value={ym.split("-")[0]}
                  onChange={(ev) => {
                    const mo = ym.split("-")[1] || "01";
                    handleMonthChange(`${ev.target.value}-${mo}`);
                  }}
                >
                  {yearOptions().map((yy) => (
                    <option key={yy} value={yy}>
                      {yy}年
                    </option>
                  ))}
                </select>
                <select
                  className={styles.monthSelect}
                  aria-label="表示月"
                  value={ym.split("-")[1] || "01"}
                  onChange={(ev) => {
                    const y = ym.split("-")[0] || String(new Date().getFullYear());
                    handleMonthChange(`${y}-${ev.target.value}`);
                  }}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
                    <option key={mo} value={String(mo).padStart(2, "0")}>
                      {mo}月
                    </option>
                  ))}
                </select>
              </span>
            ) : (
              <input
                id="kb-month"
                className={styles.monthInput}
                type="month"
                required
                value={ym}
                onChange={(ev) => {
                  if (ev.target.value) handleMonthChange(ev.target.value);
                }}
                onInput={(ev) => {
                  const v = (ev.target as HTMLInputElement).value;
                  if (/^\d{4}-\d{2}$/.test(v)) handleMonthChange(v);
                }}
              />
            )}
          </label>
          <button
            type="button"
            className={styles.btn}
            disabled={loading || !base}
            onClick={() => void load()}
          >
            {loading ? "読込中…" : "再読込"}
          </button>
        </div>
      </header>
      {isParentForKidWatch && kidMemberRows.length > 0 ? (
        <div
          className={`${styles.kidWatchControls} ${kidWatchOn ? styles.kidWatchControlsActive : ""}`}
        >
          <label className={styles.kidWatchToggle}>
            <input
              type="checkbox"
              checked={kidWatchOn}
              onChange={(ev) => {
                const on = ev.target.checked;
                navigateWithSearch((p) => {
                  if (on) {
                    p.set("kidWatch", "1");
                  } else {
                    p.delete("kidWatch");
                    p.delete("kidUser");
                  }
                });
              }}
            />
            子どものお小遣い帳を表示
          </label>
          {kidWatchOn ? (
            <label className={styles.kidWatchChildPick}>
              <span className={styles.kidWatchChildPickLabel}>表示する子</span>
              <select
                key={`kid-pick-${kidMemberRows.map((m) => m.id).join("-")}`}
                className={`${styles.monthSelect} ${styles.kidWatchChildSelect}`}
                value={selectedKidUserId != null ? String(selectedKidUserId) : ""}
                onChange={(ev) => {
                  const v = ev.target.value.trim();
                  navigateWithSearch((p) => {
                    p.set("kidWatch", "1");
                    if (!v) p.delete("kidUser");
                    else p.set("kidUser", v);
                  });
                }}
                aria-label="お小遣い帳を表示する子ども"
              >
                <option value="">子ども全員（合算）</option>
                {kidMemberRows.map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    {m.display_name?.trim() || m.email || `ユーザー ${m.id}`}
                  </option>
                ))}
              </select>
              {!loading && kidMemberRows.length === 0 ? (
                <span className={styles.kidWatchChildHint}>
                  一覧が空のときは、管理画面で該当ユーザーの family_role を KID にしてください。
                </span>
              ) : null}
            </label>
          ) : null}
          {kidWatchOn ? (
            <span className={styles.kidWatchModeNote}>見守りモード（ヘッダー色も変わります）</span>
          ) : (
            <span className={styles.kidWatchModeNote}>家計簿モード</span>
          )}
        </div>
      ) : null}
      {error ? (
        <div className={styles.err} role="alert">
          {error}
        </div>
      ) : null}
      {bulkDeleteMessage ? (
        <div style={{ color: "var(--accent)", fontWeight: 700, marginBottom: "0.75rem" }}>{bulkDeleteMessage}</div>
      ) : null}

      {!error && categories.length === 0 && !loading && base ? (
        <div className={styles.empty} role="status" style={{ marginBottom: "1rem" }}>
          カテゴリがまだありません。再読込しても空の場合は{" "}
          <Link to="/categories">カテゴリ管理</Link>
          から追加できます。
        </div>
      ) : null}

      <div className={styles.summaryAmountsToolbar}>
        <label className={styles.summaryAmountsToggle}>
          <input
            type="checkbox"
            checked={summaryAmountsVisible}
            onChange={(e) => setSummaryAmountsVisible(e.target.checked)}
          />
          <span>今月の合計金額を表示する</span>
        </label>
      </div>

      <div className={styles.cards}>
        <div className={`${styles.card} ${styles.cardIncome}`}>
          <div className={styles.cardLabel} title="収入（今月）">
            収入（今月）
          </div>
          <div
            className={`${styles.cardValue} ${styles.income}`}
            {...(!summaryAmountsVisible
              ? { role: "status", "aria-label": "収入の金額は非表示です" }
              : {})}
          >
            {summaryAmountsVisible ? (
              formatYenSingleLine(incomeTotalNum)
            ) : (
              <span className={styles.cardValueHidden} aria-hidden="true">
                ¥ •••••••
              </span>
            )}
          </div>
        </div>
        <div className={`${styles.card} ${styles.cardExpense}`}>
          <div
            className={styles.cardLabel}
            title="収入または変動費（家計簿）のどちらかが0より大きい月は、ここに設定画面の固定費（月額合計）を加えた合計です。収入も変動費も無い月は固定費を含めません。"
          >
            支出（今月）
          </div>
          <div
            className={`${styles.cardValue} ${styles.expense}`}
            {...(!summaryAmountsVisible
              ? { role: "status", "aria-label": "支出の金額は非表示です" }
              : {})}
          >
            {summaryAmountsVisible ? (
              formatYenSingleLine(expenseWithFixedDisplayNum)
            ) : (
              <span className={styles.cardValueHidden} aria-hidden="true">
                ¥ •••••••
              </span>
            )}
          </div>
        </div>
        <div className={styles.card}>
          <div
            className={styles.cardLabel}
            title="収入 − 支出（今月）。収入または変動費がある月のみ支出に固定費を含め、APIの収支残金と一致します。"
          >
            残金（今月あといくら）
          </div>
          <div
            className={`${styles.cardValue} ${
              balanceNum >= 0 ? styles.balancePositive : styles.balanceNegative
            }`}
            {...(!summaryAmountsVisible
              ? { role: "status", "aria-label": "残金の金額は非表示です" }
              : {})}
          >
            {summaryAmountsVisible ? (
              formatYenSingleLine(balanceNum)
            ) : (
              <span className={styles.cardValueHidden} aria-hidden="true">
                ¥ •••••••
              </span>
            )}
          </div>
        </div>
      </div>

      {hasSummaryApiGrid ? (
        <div
          className={
            summaryApiThreeUp
              ? `${styles.summaryApiGrid} ${styles.summaryApiGrid3Up}`
              : styles.summaryApiGrid
          }
        >
          {hasExpenseApiSection ? (
            <section className={styles.summaryApiCol} aria-label="品目別・支出（API集計）">
              <h2 className={styles.sectionTitle}>品目別・支出（API集計）</h2>
              {summaryApiThreeUp ? (
                <div className={styles.summaryApiLead} aria-hidden="true" />
              ) : null}
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>カテゴリ</th>
                      <th>合計</th>
                      <th>詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expenseRowsOrdered.map((row, i) => (
                      <tr key={`${row.category_id ?? "x"}-${i}`}>
                        <td>{row.category_name ?? "（未分類）"}</td>
                        <td>{yen.format(numAmount(row.total as string | number))}</td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnSm}`}
                            disabled={!base}
                            onClick={() => {
                              setExpenseCategoryModal({
                                categoryId: row.category_id,
                                categoryName: row.category_name ?? "（未分類）",
                              });
                              setModalLineEdit(null);
                            }}
                          >
                            詳細
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {hasFixedCostSection ? (
            <section className={styles.summaryApiCol} aria-label="固定費明細">
              <div className={styles.summaryApiTitleRow}>
                <h2 className={styles.sectionTitle}>固定費明細</h2>
                <Link
                  to={{ pathname: "/settings", hash: "fixed-cost-settings" }}
                  className={`${styles.btn} ${styles.btnSm}`}
                >
                  固定費設定（全月共通）へ
                </Link>
              </div>
              {summaryApiThreeUp ? (
                <div className={styles.summaryApiLead} aria-hidden="true" />
              ) : null}
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>項目</th>
                      <th>金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFixedCostItems.map((item, i) => (
                      <tr key={`${item.id}-${i}`}>
                        <td
                          style={{ whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}
                        >
                          {item.category || "固定費"}
                        </td>
                        <td>{yen.format(numAmount(item.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {txMobileNarrow && fixedCostItemsForMonth.length > mobileFixedCostInitialRows ? (
                  <div
                    style={{ padding: "0.45rem 0.55rem", borderTop: "1px solid var(--border)" }}
                  >
                    <button
                      type="button"
                      className={styles.btn}
                      style={{ width: "100%" }}
                      onClick={() => setFixedCostExpanded((v) => !v)}
                    >
                      {fixedCostExpanded
                        ? "固定費明細を折りたたむ"
                        : `固定費明細をすべて表示（全${fixedCostItemsForMonth.length}件）`}
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
          {hasIncomeApiSection && summary ? (
            <section className={styles.summaryApiCol} aria-label="品目別・収入（API集計）">
              <h2 className={styles.sectionTitle}>品目別・収入（API集計）</h2>
              {summaryApiThreeUp ? (
                <div className={styles.summaryApiLead} aria-hidden="true" />
              ) : null}
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>カテゴリ</th>
                      <th>合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.incomesByCategory.map((row, i) => (
                      <tr key={`${row.category_id ?? "y"}-${i}`}>
                        <td>{row.category_name ?? "（未分類）"}</td>
                        <td>{yen.format(numAmount(row.total as string | number))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {!kidWatchOn ? <h2 className={styles.sectionTitle}>取引を追加</h2> : null}
      {!kidWatchOn ? (
      <form
        className={styles.form}
        data-kakeibo-tx-add
        onSubmit={handleAdd}
      >
        <div className={styles.txAddLine1}>
          <div className={styles.field}>
            <label htmlFor="kb-kind">種別</label>
            <select
              id="kb-kind"
              value={formKind}
              onChange={(ev) => {
                const nextKind = ev.target.value as "expense" | "income";
                setFormKind(nextKind);
                setFormCategoryId("");
                applyMedicalDefaultsToAddForm("", nextKind);
              }}
            >
              <option value="expense">支出</option>
              <option value="income">収入</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="kb-cat">カテゴリ</label>
            <select
              id="kb-cat"
              key={`kb-cat-${formKind}`}
              value={formCategoryId}
              onChange={(ev) => {
                const nextId = ev.target.value;
                setFormCategoryId(nextId);
                applyMedicalDefaultsToAddForm(nextId, formKind);
              }}
            >
              <option value="">なし</option>
              {filteredCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="kb-date">日付</label>
            <input
              id="kb-date"
              type="date"
              value={formDate}
              onChange={(ev) => setFormDate(ev.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kb-amt">金額</label>
            <input
              id="kb-amt"
              type="number"
              min={formKind === "income" ? 0 : 1}
              step={1}
              placeholder="1200"
              value={formAmount}
              onChange={(ev) => setFormAmount(ev.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kb-memo">メモ</label>
            <input
              id="kb-memo"
              type="text"
              placeholder="メモ"
              value={formMemo}
              onChange={(ev) => setFormMemo(ev.target.value)}
            />
          </div>
        </div>
        {formKind === "expense" ? (
          <div className={styles.txAddLineMedical}>
            <div className={`${styles.field} ${styles.txAddFieldMedicalCheck}`}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={formIsMedicalExpense}
                  onChange={(ev) => setFormIsMedicalExpense(ev.target.checked)}
                />
                医療費控除の対象
              </label>
            </div>
            <div className={styles.field}>
              <label htmlFor="kb-medical-type">医療費の3区分</label>
              <select
                id="kb-medical-type"
                value={formMedicalType}
                onChange={(ev) => setFormMedicalType((ev.target.value as MedicalType | "") ?? "")}
                disabled={!formIsMedicalExpense}
              >
                <option value="">選択してください</option>
                <option value="treatment">診療・治療</option>
                <option value="medicine">医薬品</option>
                <option value="other">その他</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="kb-medical-patient">対象者名</label>
              <input
                id="kb-medical-patient"
                type="text"
                value={formMedicalPatientName}
                onChange={(ev) => setFormMedicalPatientName(ev.target.value)}
                maxLength={120}
                placeholder="対象者名"
                disabled={!formIsMedicalExpense}
              />
            </div>
            <div className={styles.txAddLineMedicalAction}>
              <button
                type="submit"
                className={`${styles.btn} ${styles.btnPrimary} ${styles.txAddSubmitBtn}`}
                disabled={saving || !base}
              >
                {saving ? null : <Plus className={styles.txAddSubmitBtnIcon} size={16} aria-hidden />}
                {saving ? "保存中…" : "追加"}
              </button>
            </div>
          </div>
        ) : null}
        {formKind === "income" ? (
          <div className={styles.txAddSubmitRow}>
            <button
              type="submit"
              className={`${styles.btn} ${styles.btnPrimary} ${styles.txAddSubmitBtn}`}
              disabled={saving || !base}
            >
              {saving ? null : <Plus className={styles.txAddSubmitBtnIcon} size={16} aria-hidden />}
              {saving ? "保存中…" : "追加"}
            </button>
          </div>
        ) : null}
      </form>
      ) : null}

      <h2 className={styles.sectionTitle}>
        取引一覧（{from} 〜 {to} / {transactions.length}件）
      </h2>
      {!kidWatchOn && selectedCount > 0 ? (
        <div style={{ marginBottom: "0.6rem", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={() => void removeSelectedTransactions()}
            disabled={!base}
          >
            選択した項目を削除（{selectedCount}件）
          </button>
        </div>
      ) : null}
      <div className={styles.tableWrap}>
        <table
          className={`${styles.table} ${styles.txTable}`}
          style={{ ["--tx-cat-ch" as string]: String(txCategoryMinCh) }}
        >
          <thead>
            <tr>
              <th style={{ width: "2.4rem" }}>
                {!kidWatchOn ? (
                  <input
                    type="checkbox"
                    aria-label="すべて選択"
                    checked={allVisibleSelected}
                    onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                  />
                ) : null}
              </th>
              <th className={styles.kindCol}>種別</th>
              <th className={styles.txColCategory}>カテゴリ</th>
              <th className={styles.txColDate}>日付</th>
              <th>金額</th>
              <th>メモ</th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className={styles.empty}>
                    {kidWatchOn
                      ? "この月・この条件のお小遣い帳の取引はまだありません。"
                      : "この月の取引はまだありません。上のフォームから追加するか、別画面で登録済みか確認してください。"}
                  </div>
                </td>
              </tr>
            ) : (
              visibleTransactions.map((t) => {
                const isEditing = edit?.id === t.id;
                const rowKind =
                  t.kind === "income"
                    ? styles.trIncome
                    : t.kind === "expense"
                      ? styles.trExpense
                      : styles.trNeutral;

                const categoryDisplay =
                  t.category_id != null
                    ? (() => {
                        const cid =
                          typeof t.category_id === "number"
                            ? t.category_id
                            : Number(t.category_id);
                        return Number.isFinite(cid)
                          ? (categoryById.get(cid) ?? `ID:${cid}`)
                          : "—";
                      })()
                    : "—";

                if (isEditing && edit && txMobileNarrow) {
                  return (
                    <tr
                      key={t.id}
                      className={`${rowKind} ${styles.rowEditing} ${styles.mobileTxEditRow}`}
                    >
                      <td>
                        {!kidWatchOn ? (
                          <input
                            type="checkbox"
                            checked={selectedTxIds.includes(t.id)}
                            onChange={(ev) => toggleSelectOne(t.id, ev.target.checked)}
                            aria-label={`明細${t.id}を選択`}
                          />
                        ) : null}
                      </td>
                      <td colSpan={5} className={styles.mobileTxEditCell}>
                        <div className={styles.mobileTxEdit}>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>種別</span>
                            <select
                              className={styles.mobileTxEditInput}
                              value={edit.kind}
                              onChange={(ev) =>
                                applyMedicalDefaultsToEdit("", ev.target.value as "expense" | "income")
                              }
                              aria-label="種別"
                            >
                              <option value="expense">支出</option>
                              <option value="income">収入</option>
                            </select>
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>カテゴリ</span>
                            <select
                              className={styles.mobileTxEditInput}
                              value={edit.category_id}
                              onChange={(ev) => applyMedicalDefaultsToEdit(ev.target.value, edit.kind)}
                              aria-label="カテゴリ"
                            >
                              <option value="">なし</option>
                              {editCategories.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>日付</span>
                            <input
                              className={styles.mobileTxEditInput}
                              type="text"
                              inputMode="numeric"
                              placeholder="MM/DD"
                              autoComplete="off"
                              value={mobileEditDateText}
                              onChange={(ev) => {
                                const v = ev.target.value;
                                setMobileEditDateText(v);
                                const ymd = parseMdToYmd(v, edit.transaction_date);
                                if (ymd) setEdit({ ...edit, transaction_date: ymd });
                              }}
                              aria-label="取引日（月/日）"
                            />
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>金額</span>
                            <input
                              className={styles.mobileTxEditInput}
                              type="number"
                              min={edit.kind === "income" ? 0 : 1}
                              step={1}
                              value={edit.amount}
                              onChange={(ev) =>
                                setEdit({ ...edit, amount: ev.target.value })
                              }
                              aria-label="金額"
                            />
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>メモ</span>
                            <input
                              className={styles.mobileTxEditInput}
                              type="text"
                              value={edit.memo}
                              onChange={(ev) =>
                                setEdit({ ...edit, memo: ev.target.value })
                              }
                              placeholder="メモ"
                              aria-label="メモ"
                            />
                          </div>
                          {edit.kind === "expense" ? (
                            <>
                              <div className={styles.mobileTxEditField}>
                                <span className={styles.mobileTxEditLabel}>医療費控除</span>
                                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <input
                                    type="checkbox"
                                    checked={edit.is_medical_expense}
                                    onChange={(ev) =>
                                      setEdit({
                                        ...edit,
                                        is_medical_expense: ev.target.checked,
                                        medical_type: ev.target.checked ? edit.medical_type : "",
                                        medical_patient_name: ev.target.checked
                                          ? edit.medical_patient_name
                                          : "",
                                      })
                                    }
                                  />
                                  対象
                                </label>
                              </div>
                              <div className={styles.mobileTxEditField}>
                                <span className={styles.mobileTxEditLabel}>3区分</span>
                                <select
                                  className={styles.mobileTxEditInput}
                                  value={edit.medical_type}
                                  onChange={(ev) =>
                                    setEdit({
                                      ...edit,
                                      medical_type: (ev.target.value as MedicalType | "") ?? "",
                                    })
                                  }
                                  disabled={!edit.is_medical_expense}
                                >
                                  <option value="">選択してください</option>
                                  <option value="treatment">診療・治療</option>
                                  <option value="medicine">医薬品</option>
                                  <option value="other">その他</option>
                                </select>
                              </div>
                              <div className={styles.mobileTxEditField}>
                                <span className={styles.mobileTxEditLabel}>対象者</span>
                                <input
                                  className={styles.mobileTxEditInput}
                                  type="text"
                                  value={edit.medical_patient_name}
                                  onChange={(ev) =>
                                    setEdit({ ...edit, medical_patient_name: ev.target.value })
                                  }
                                  maxLength={120}
                                  placeholder="例: 子ども"
                                  disabled={!edit.is_medical_expense}
                                />
                              </div>
                            </>
                          ) : null}
                          <div className={styles.mobileTxEditActions}>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnPrimary}`}
                              disabled={editSaving || !base}
                              onClick={() => void saveEdit()}
                            >
                              {editSaving ? "保存中…" : "保存"}
                            </button>
                            <button
                              type="button"
                              className={styles.btn}
                              disabled={editSaving}
                              onClick={cancelEdit}
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                if (txMobileNarrow && !isEditing) {
                  return (
                    <tr key={t.id} className={`${rowKind} ${styles.mobileTxViewRow}`}>
                      <td>
                        {!kidWatchOn ? (
                          <input
                            type="checkbox"
                            checked={selectedTxIds.includes(t.id)}
                            onChange={(ev) => toggleSelectOne(t.id, ev.target.checked)}
                            aria-label={`明細${t.id}を選択`}
                          />
                        ) : null}
                      </td>
                      <td colSpan={5} className={styles.mobileTxViewCell}>
                        <div className={styles.mobileTxView}>
                          <div className={styles.mobileTxViewRow1}>
                            <span
                              className={`${styles.kind} ${styles.mobileTxViewKind} ${
                                t.kind === "income"
                                  ? styles.kindIncome
                                  : t.kind === "expense"
                                    ? styles.kindExpense
                                    : styles.kindOther
                              }`}
                            >
                              {t.kind === "income"
                                ? "収入"
                                : t.kind === "expense"
                                  ? "支出"
                                  : t.kind}
                            </span>
                            <div className={styles.mobileTxViewDateAmt}>
                              <span
                                className={styles.mobileTxViewDate}
                                title={formatTxDateYmd(t.transaction_date)}
                              >
                                {formatTxDateMd(t.transaction_date)}
                              </span>
                              <span className={styles.mobileTxViewAmt}>
                                {yen.format(numAmount(t.amount))}
                              </span>
                            </div>
                            <span
                              className={styles.mobileTxViewCat}
                              title={categoryDisplay}
                            >
                              {categoryDisplay}
                            </span>
                          </div>
                          <div className={styles.mobileTxViewRow2}>
                            <span
                              className={styles.mobileTxViewMemo}
                              title={t.memo?.trim() ? t.memo : undefined}
                            >
                              {t.memo ?? ""}
                            </span>
                          </div>
                          {!kidWatchOn ? (
                            <div className={styles.mobileTxViewActions}>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${styles.mobileTxViewBtn}`}
                                disabled={!base}
                                onClick={() => beginEdit(t)}
                              >
                                変更
                              </button>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger} ${styles.mobileTxViewBtn}`}
                                disabled={!base}
                                onClick={() => void removeTransaction(t.id)}
                              >
                                削除
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr
                    key={t.id}
                    className={`${rowKind}${isEditing ? ` ${styles.rowEditing}` : ""}`}
                  >
                    <td>
                      {!kidWatchOn ? (
                        <input
                          type="checkbox"
                          checked={selectedTxIds.includes(t.id)}
                          onChange={(ev) => toggleSelectOne(t.id, ev.target.checked)}
                          aria-label={`明細${t.id}を選択`}
                        />
                      ) : null}
                    </td>
                    <td className={styles.kindCol}>
                      {isEditing && edit ? (
                        <select
                          className={styles.cellInput}
                          value={edit.kind}
                          onChange={(ev) =>
                            applyMedicalDefaultsToEdit("", ev.target.value as "expense" | "income")
                          }
                          aria-label="種別"
                        >
                          <option value="expense">支出</option>
                          <option value="income">収入</option>
                        </select>
                      ) : (
                        <span
                          className={`${styles.kind} ${
                            t.kind === "income"
                              ? styles.kindIncome
                              : t.kind === "expense"
                                ? styles.kindExpense
                                : styles.kindOther
                          }`}
                        >
                          {t.kind === "income"
                            ? "収入"
                            : t.kind === "expense"
                              ? "支出"
                              : t.kind}
                        </span>
                      )}
                    </td>
                    <td className={styles.txColCategory}>
                      {isEditing && edit ? (
                        <select
                          className={styles.cellInput}
                          value={edit.category_id}
                          onChange={(ev) => applyMedicalDefaultsToEdit(ev.target.value, edit.kind)}
                          aria-label="カテゴリ"
                        >
                          <option value="">なし</option>
                          {editCategories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        categoryDisplay
                      )}
                    </td>
                    <td className={styles.txColDate}>
                      {isEditing && edit ? (
                        <input
                          className={`${styles.cellInput} ${styles.txDateInput}`}
                          type="date"
                          value={edit.transaction_date}
                          onChange={(ev) =>
                            setEdit({ ...edit, transaction_date: ev.target.value })
                          }
                          aria-label="取引日"
                        />
                      ) : (
                        <span
                          title={formatTxDateYmd(t.transaction_date)}
                          className={styles.txDateCell}
                        >
                          {formatTxDateMd(t.transaction_date)}
                        </span>
                      )}
                    </td>
                    <td>
                      {isEditing && edit ? (
                        <input
                          className={styles.cellInput}
                          type="number"
                          min={edit.kind === "income" ? 0 : 1}
                          step={1}
                          value={edit.amount}
                          onChange={(ev) =>
                            setEdit({ ...edit, amount: ev.target.value })
                          }
                          aria-label="金額"
                        />
                      ) : (
                        yen.format(numAmount(t.amount))
                      )}
                    </td>
                    <td>
                      {isEditing && edit ? (
                        <div className={styles.memoCell}>
                          <input
                            className={styles.cellInput}
                            type="text"
                            value={edit.memo}
                            onChange={(ev) =>
                              setEdit({ ...edit, memo: ev.target.value })
                            }
                            placeholder="メモ"
                            aria-label="メモ"
                          />
                          {edit.kind === "expense" ? (
                            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <input
                                  type="checkbox"
                                  checked={edit.is_medical_expense}
                                  onChange={(ev) =>
                                    setEdit({
                                      ...edit,
                                      is_medical_expense: ev.target.checked,
                                      medical_type: ev.target.checked ? edit.medical_type : "",
                                      medical_patient_name: ev.target.checked
                                        ? edit.medical_patient_name
                                        : "",
                                    })
                                  }
                                />
                                医療費控除の対象
                              </label>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <select
                                  className={styles.cellInput}
                                  value={edit.medical_type}
                                  onChange={(ev) =>
                                    setEdit({
                                      ...edit,
                                      medical_type: (ev.target.value as MedicalType | "") ?? "",
                                    })
                                  }
                                  disabled={!edit.is_medical_expense}
                                  aria-label="医療費3区分"
                                >
                                  <option value="">選択してください</option>
                                  <option value="treatment">診療・治療</option>
                                  <option value="medicine">医薬品</option>
                                  <option value="other">その他</option>
                                </select>
                                <input
                                  className={styles.cellInput}
                                  type="text"
                                  value={edit.medical_patient_name}
                                  onChange={(ev) =>
                                    setEdit({ ...edit, medical_patient_name: ev.target.value })
                                  }
                                  maxLength={120}
                                  placeholder="対象者名"
                                  disabled={!edit.is_medical_expense}
                                  aria-label="医療費対象者"
                                />
                              </div>
                            </div>
                          ) : null}
                          <div className={styles.rowActions}>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                              disabled={editSaving || !base}
                              onClick={() => void saveEdit()}
                            >
                              {editSaving ? "保存中…" : "保存"}
                            </button>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm}`}
                              disabled={editSaving}
                              onClick={cancelEdit}
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className={styles.memoCell}>
                          <span className={styles.memoText}>
                            {t.memo ?? ""}
                            {t.is_medical_expense === true || Number(t.is_medical_expense) === 1 ? (
                              <span style={{ marginLeft: 8, fontSize: "0.82em", color: "#0369a1" }}>
                                {" "}
                                [医療費:{" "}
                                {t.medical_type === "treatment" ||
                                t.medical_type === "medicine" ||
                                t.medical_type === "other"
                                  ? MEDICAL_TYPE_LABELS[t.medical_type]
                                  : "未設定"}
                                {t.medical_patient_name ? ` / ${t.medical_patient_name}` : ""}]
                              </span>
                            ) : null}
                          </span>
                          {!kidWatchOn ? (
                            <div className={styles.rowActions}>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm}`}
                                disabled={!base}
                                onClick={() => beginEdit(t)}
                              >
                                変更
                              </button>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                                disabled={!base}
                                onClick={() => void removeTransaction(t.id)}
                              >
                                削除
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        {transactions.length > txInitialRows ? (
          <div style={{ padding: "0.45rem 0.55rem", borderTop: "1px solid var(--border)" }}>
            <button
              type="button"
              className={styles.btn}
              style={{ width: "100%" }}
              onClick={() => setTransactionsExpanded((v) => !v)}
            >
              {transactionsExpanded
                ? "取引一覧を折りたたむ"
                : `取引一覧をすべて表示（全${transactions.length}件）`}
            </button>
          </div>
        ) : null}
      </div>
    </div>
    {expenseCategoryModal && typeof document !== "undefined" ? createPortal(
      <div
        className={styles.categoryDetailBackdrop}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeExpenseCategoryModal();
        }}
      >
        <div
          className={styles.categoryDetailDialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="kakeibo-category-modal-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className={styles.categoryDetailHeader} id="kakeibo-category-modal-title">
            <span>
              カテゴリ明細: {expenseCategoryModal.categoryName}
              {kidWatchOn ? (
                <span
                  className={styles.categoryDetailSub}
                  style={{ display: "block" }}
                >
                  お小遣い帳（見守り）のため表示のみです。
                </span>
              ) : null}
            </span>
            <button
              type="button"
              className={styles.btn}
              onClick={closeExpenseCategoryModal}
            >
              閉じる
            </button>
          </h2>
          <p className={styles.categoryDetailSub} style={{ margin: "0.25rem 0 0" }}>
            {(() => {
              const [yy, mo] = ym.split("-");
              const mNum = Number(mo);
              return `${yy}年${Number.isFinite(mNum) ? mNum : mo}月分`;
            })()}{" "}
            ・ {from} 〜 {to} の該当支出のみ（{expenseCategoryModalTx.length}件）
          </p>
          {showMedicalCsvNotice && !kidWatchOn ? (
            <p className={styles.categoryDetailMedicalNote}>
              <strong>医療費控除用CSV</strong>
              ：すでにダウンロードしたファイルには、ここでの修正は<strong>反映されません</strong>。最新に揃える場合は
              <strong>再エクスポート</strong>してください。
            </p>
          ) : null}
          <div className={styles.categoryDetailDialogBody}>
            {txMobileNarrow ? (
              <div className={styles.categoryDetailMobileRoot}>
                {expenseCategoryModalTx.length === 0 ? (
                  <div className={styles.categoryDetailMobileEmpty}>
                    <div className={styles.empty}>
                      該当する支出明細はありません（他画面で分類を変更した場合、一覧に合わないことがあります）。
                    </div>
                  </div>
                ) : (
                  <div className={styles.categoryDetailMobileList}>
                    {expenseCategoryModalTx.map((t) => {
                      const isEd = !kidWatchOn && modalLineEdit?.id === t.id;
                      const m = modalLineEdit;
                      if (isEd && m) {
                        return (
                          <div
                            key={t.id}
                            className={`${styles.categoryDetailCard} ${styles.rowEditing}`}
                          >
                            <div className={styles.categoryDetailCardEditLine1}>
                              <input
                                className={`${styles.cellInput} ${styles.categoryDetailCardDateInput}`}
                                type="date"
                                value={m.transaction_date}
                                onChange={(ev) =>
                                  setModalLineEdit({ ...m, transaction_date: ev.target.value })
                                }
                                aria-label="日付"
                              />
                              <input
                                className={`${styles.cellInput} ${styles.categoryDetailCardAmountInput}`}
                                type="number"
                                min={m.kind === "income" ? 0 : 1}
                                step={1}
                                value={m.amount}
                                onChange={(ev) => setModalLineEdit({ ...m, amount: ev.target.value })}
                                aria-label="金額"
                              />
                            </div>
                            <div className={styles.categoryDetailCardEditForm}>
                              <div className={styles.categoryDetailEditCell} style={{ minWidth: 0 }}>
                                <div className={styles.categoryDetailEditKindRow}>
                                  <select
                                    className={styles.cellInput}
                                    value={m.kind}
                                    onChange={(ev) =>
                                      applyMedicalDefaultsToModalLineEdit(
                                        m.category_id,
                                        ev.target.value as "expense" | "income",
                                      )
                                    }
                                    aria-label="種別"
                                  >
                                    <option value="expense">支出</option>
                                    <option value="income">収入</option>
                                  </select>
                                  <select
                                    className={styles.cellInput}
                                    value={m.category_id}
                                    onChange={(ev) =>
                                      applyMedicalDefaultsToModalLineEdit(ev.target.value, m.kind)
                                    }
                                    aria-label="カテゴリ"
                                  >
                                    <option value="">なし</option>
                                    {modalEditCategories.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <input
                                  className={`${styles.cellInput} ${styles.categoryDetailEditMemoField}`}
                                  type="text"
                                  value={m.memo}
                                  onChange={(ev) => setModalLineEdit({ ...m, memo: ev.target.value })}
                                  placeholder="内容・メモ"
                                  aria-label="内容"
                                />
                                {m.kind === "expense" ? (
                                  <div className={styles.categoryDetailEditMedical}>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={m.is_medical_expense}
                                        onChange={(ev) =>
                                          setModalLineEdit({
                                            ...m,
                                            is_medical_expense: ev.target.checked,
                                            medical_type: ev.target.checked ? m.medical_type : "",
                                            medical_patient_name: ev.target.checked
                                              ? m.medical_patient_name
                                              : "",
                                          })
                                        }
                                      />{" "}
                                      医療費控除の対象
                                    </label>
                                    <div className={styles.categoryDetailEditMedicalRow}>
                                      <select
                                        className={styles.cellInput}
                                        value={m.medical_type}
                                        onChange={(ev) =>
                                          setModalLineEdit({
                                            ...m,
                                            medical_type: (ev.target.value as MedicalType | "") ?? "",
                                          })
                                        }
                                        disabled={!m.is_medical_expense}
                                        aria-label="医療費3区分"
                                      >
                                        <option value="">選択してください</option>
                                        <option value="treatment">診療・治療</option>
                                        <option value="medicine">医薬品</option>
                                        <option value="other">その他</option>
                                      </select>
                                      <input
                                        className={styles.cellInput}
                                        type="text"
                                        value={m.medical_patient_name}
                                        onChange={(ev) =>
                                          setModalLineEdit({ ...m, medical_patient_name: ev.target.value })
                                        }
                                        maxLength={120}
                                        placeholder="対象者名"
                                        disabled={!m.is_medical_expense}
                                        aria-label="医療費対象者"
                                      />
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                            <div className={styles.categoryDetailCardOps}>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                                disabled={modalEditSaving || !base}
                                onClick={() => void saveModalLineEdit()}
                              >
                                {modalEditSaving ? "保存中…" : "保存"}
                              </button>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm}`}
                                disabled={modalEditSaving}
                                onClick={cancelModalLineEdit}
                              >
                                キャンセル
                              </button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={t.id} className={styles.categoryDetailCard}>
                          <div className={styles.categoryDetailCardLine1}>
                            <span
                              className={styles.categoryDetailCardDate}
                              title={formatTxDateYmd(t.transaction_date)}
                            >
                              {formatTxDateMd(t.transaction_date)}
                            </span>
                            <span className={styles.categoryDetailCardAmount}>
                              {yen.format(numAmount(t.amount))}
                            </span>
                          </div>
                          <div className={styles.categoryDetailCardMemo}>
                            <span className={styles.memoText}>
                              {t.memo ?? ""}
                              {t.is_medical_expense === true || Number(t.is_medical_expense) === 1 ? (
                                <span style={{ marginLeft: 6, fontSize: "0.86em", color: "#0369a1" }}>
                                  [医療費:{" "}
                                  {t.medical_type === "treatment" ||
                                  t.medical_type === "medicine" ||
                                  t.medical_type === "other"
                                    ? MEDICAL_TYPE_LABELS[t.medical_type]
                                    : "未設定"}
                                  {t.medical_patient_name ? ` / ${t.medical_patient_name}` : ""}]
                                </span>
                              ) : null}
                            </span>
                          </div>
                          {kidWatchOn ? null : (
                            <div className={styles.categoryDetailCardOps}>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm}`}
                                disabled={!base}
                                onClick={() => beginModalLineEdit(t)}
                              >
                                編集
                              </button>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                                disabled={!base}
                                onClick={() => void removeTransaction(t.id)}
                              >
                                削除
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <table className={styles.categoryDetailTable}>
              <thead>
                <tr>
                  <th colSpan={4} className={styles.categoryDetailTableTheadRow}>
                    上段: 日付・金額 ／ 下段: 内容
                  </th>
                </tr>
              </thead>
              <tbody>
                {expenseCategoryModalTx.length === 0 ? (
                  <tr>
                    <td colSpan={4} className={styles.categoryDetailTableEmptyCell}>
                      <div className={styles.empty}>
                        該当する支出明細はありません（他画面で分類を変更した場合、一覧に合わないことがあります）。
                      </div>
                    </td>
                  </tr>
                ) : (
                  expenseCategoryModalTx.map((t) => {
                    const isEd = !kidWatchOn && modalLineEdit?.id === t.id;
                    const m = modalLineEdit;
                    if (isEd && m) {
                      return (
                        <tr key={t.id} className={styles.rowEditing}>
                          <td colSpan={4} className={styles.categoryDetailDesktopRowCell}>
                            <div className={styles.categoryDetailRowBlock}>
                              <div className={styles.categoryDetailRowLine1}>
                                <div
                                  className={styles.categoryDetailRowDateAmount}
                                  role="group"
                                  aria-label="日付と金額"
                                >
                                  <input
                                    className={`${styles.cellInput} ${styles.categoryDetailDateInput} ${styles.categoryDetailRowDateInput}`}
                                    type="date"
                                    value={m.transaction_date}
                                    onChange={(ev) =>
                                      setModalLineEdit({ ...m, transaction_date: ev.target.value })
                                    }
                                    aria-label="日付"
                                  />
                                  <input
                                    className={`${styles.cellInput} ${styles.categoryDetailRowAmountInput}`}
                                    type="number"
                                    min={m.kind === "income" ? 0 : 1}
                                    step={1}
                                    value={m.amount}
                                    onChange={(ev) => setModalLineEdit({ ...m, amount: ev.target.value })}
                                    aria-label="金額"
                                  />
                                </div>
                                <div className={styles.categoryDetailRowLine1Ops}>
                                  <button
                                    type="button"
                                    className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                                    disabled={modalEditSaving || !base}
                                    onClick={() => void saveModalLineEdit()}
                                  >
                                    {modalEditSaving ? "保存中…" : "保存"}
                                  </button>
                                  <button
                                    type="button"
                                    className={`${styles.btn} ${styles.btnSm}`}
                                    disabled={modalEditSaving}
                                    onClick={cancelModalLineEdit}
                                  >
                                    キャンセル
                                  </button>
                                </div>
                              </div>
                              <div className={styles.categoryDetailRowLine2Edit}>
                                <div className={styles.categoryDetailEditCell}>
                                  <div className={styles.categoryDetailEditKindRow}>
                                    <select
                                      className={styles.cellInput}
                                      value={m.kind}
                                      onChange={(ev) =>
                                        applyMedicalDefaultsToModalLineEdit(
                                          m.category_id,
                                          ev.target.value as "expense" | "income",
                                        )
                                      }
                                      aria-label="種別"
                                    >
                                      <option value="expense">支出</option>
                                      <option value="income">収入</option>
                                    </select>
                                    <select
                                      className={styles.cellInput}
                                      value={m.category_id}
                                      onChange={(ev) =>
                                        applyMedicalDefaultsToModalLineEdit(ev.target.value, m.kind)
                                      }
                                      aria-label="カテゴリ"
                                    >
                                      <option value="">なし</option>
                                      {modalEditCategories.map((c) => (
                                        <option key={c.id} value={c.id}>
                                          {c.name}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <input
                                    className={`${styles.cellInput} ${styles.categoryDetailEditMemoField}`}
                                    type="text"
                                    value={m.memo}
                                    onChange={(ev) => setModalLineEdit({ ...m, memo: ev.target.value })}
                                    placeholder="内容・メモ"
                                    aria-label="内容"
                                  />
                                  {m.kind === "expense" ? (
                                    <div className={styles.categoryDetailEditMedical}>
                                      <label>
                                        <input
                                          type="checkbox"
                                          checked={m.is_medical_expense}
                                          onChange={(ev) =>
                                            setModalLineEdit({
                                              ...m,
                                              is_medical_expense: ev.target.checked,
                                              medical_type: ev.target.checked ? m.medical_type : "",
                                              medical_patient_name: ev.target.checked
                                                ? m.medical_patient_name
                                                : "",
                                            })
                                          }
                                        />{" "}
                                        医療費控除の対象
                                      </label>
                                      <div className={styles.categoryDetailEditMedicalRow}>
                                        <select
                                          className={styles.cellInput}
                                          value={m.medical_type}
                                          onChange={(ev) =>
                                            setModalLineEdit({
                                              ...m,
                                              medical_type: (ev.target.value as MedicalType | "") ?? "",
                                            })
                                          }
                                          disabled={!m.is_medical_expense}
                                          aria-label="医療費3区分"
                                        >
                                          <option value="">選択してください</option>
                                          <option value="treatment">診療・治療</option>
                                          <option value="medicine">医薬品</option>
                                          <option value="other">その他</option>
                                        </select>
                                        <input
                                          className={styles.cellInput}
                                          type="text"
                                          value={m.medical_patient_name}
                                          onChange={(ev) =>
                                            setModalLineEdit({ ...m, medical_patient_name: ev.target.value })
                                          }
                                          maxLength={120}
                                          placeholder="対象者名"
                                          disabled={!m.is_medical_expense}
                                          aria-label="医療費対象者"
                                        />
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={t.id}>
                        <td colSpan={4} className={styles.categoryDetailDesktopRowCell}>
                          <div className={styles.categoryDetailRowBlock}>
                            <div className={styles.categoryDetailRowLine1}>
                              <div
                                className={styles.categoryDetailRowDateAmount}
                                role="group"
                                aria-label="日付と金額"
                              >
                                <span
                                  className={styles.categoryDetailRowDate}
                                  title={formatTxDateYmd(t.transaction_date)}
                                >
                                  {formatTxDateMd(t.transaction_date)}
                                </span>
                                <span className={styles.categoryDetailRowAmount}>
                                  {yen.format(numAmount(t.amount))}
                                </span>
                              </div>
                              {kidWatchOn ? null : (
                                <div className={styles.categoryDetailRowLine1Ops}>
                                  <button
                                    type="button"
                                    className={`${styles.btn} ${styles.btnSm}`}
                                    disabled={!base}
                                    onClick={() => beginModalLineEdit(t)}
                                  >
                                    編集
                                  </button>
                                  <button
                                    type="button"
                                    className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                                    disabled={!base}
                                    onClick={() => void removeTransaction(t.id)}
                                  >
                                    削除
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className={styles.categoryDetailRowLine2Body}>
                              <span className={styles.memoText} style={{ whiteSpace: "normal" }}>
                                {t.memo ?? ""}
                                {t.is_medical_expense === true || Number(t.is_medical_expense) === 1 ? (
                                  <span style={{ marginLeft: 6, fontSize: "0.86em", color: "#0369a1" }}>
                                    [医療費:{" "}
                                    {t.medical_type === "treatment" ||
                                    t.medical_type === "medicine" ||
                                    t.medical_type === "other"
                                      ? MEDICAL_TYPE_LABELS[t.medical_type]
                                      : "未設定"}
                                    {t.medical_patient_name ? ` / ${t.medical_patient_name}` : ""}]
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            )}
          </div>
        </div>
      </div>
    , document.body) : null}
    </>
  );
}
